import type {
  ConstraintDiffCategory,
  ConstraintDiffReport,
  ConstraintDiffRow,
  ConstraintSourceDisposition,
  ConstraintSourceRecord,
  LegacyRuleSourceRecord,
  ValidatedConstraintCompilerDecision,
} from "./types";

function legacySourcesOnly(sources: ConstraintSourceRecord[]): LegacyRuleSourceRecord[] {
  return sources.filter((source): source is LegacyRuleSourceRecord => source.sourceKind === "legacy_rule");
}

function sourceIn(ids: string[], sourceId: string): boolean {
  return ids.includes(sourceId);
}

function categoryForSource(source: LegacyRuleSourceRecord, decision: ValidatedConstraintCompilerDecision): { category: ConstraintDiffCategory; disposition: ConstraintSourceDisposition; targetId?: string; reason?: string } {
  const exclusion = decision.exclusions.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  if (exclusion) {
    if (exclusion.reason === "settings_not_memory") return { category: "exclude_not_memory_settings", disposition: "excluded", reason: exclusion.reason };
    if (exclusion.reason === "tool_contract_not_memory") return { category: "exclude_not_memory_tool_contract", disposition: "excluded", reason: exclusion.reason };
    if (exclusion.reason === "knowledge_candidate") return { category: "split_knowledge_candidate", disposition: "excluded", reason: exclusion.reason };
    if (source.status !== "active") return { category: "legacy_archived_observed", disposition: "excluded", reason: `${source.status}:${exclusion.reason}` };
    return { category: "missing_mapping", disposition: "diagnostic", reason: `active source excluded as ${exclusion.reason}` };
  }

  const unresolved = decision.unresolved.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  if (unresolved) {
    return {
      category: unresolved.reason === "conflict" ? "mark_conflict" : "keep_unresolved",
      disposition: "unresolved",
      reason: unresolved.reason,
    };
  }

  const rescope = decision.rescopeProposals.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  if (rescope) {
    if (rescope.fromScope.kind === "global" && rescope.toScope.kind === "project") {
      return { category: "rescope_global_to_project", disposition: "compiled", reason: rescope.reason };
    }
    if (rescope.fromScope.kind === "project" && rescope.toScope.kind === "global") {
      return { category: "rescope_project_to_global", disposition: "compiled", reason: rescope.reason };
    }
  }

  const merge = decision.merges.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  const constraint = decision.constraints.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  if (constraint) {
    if (merge || constraint.sourceRecordIds.length > 1) {
      return { category: "merge_near_duplicates", disposition: merge ? "merged_source" : "compiled", targetId: constraint.constraintId, reason: merge?.reason };
    }
    if (constraint.compiledBody.trim().length < Math.floor(source.body.trim().length * 0.8)) {
      return { category: "compact", disposition: "compiled", targetId: constraint.constraintId };
    }
    return { category: "kept", disposition: "compiled", targetId: constraint.constraintId };
  }

  const diagnostic = decision.diagnostics.find((item) => sourceIn(item.sourceRecordIds, source.sourceId));
  if (diagnostic) {
    return { category: "missing_mapping", disposition: "diagnostic", reason: diagnostic.code };
  }

  return { category: "missing_mapping", disposition: "diagnostic", reason: "no mapping" };
}

function renderDiffMarkdown(report: Omit<ConstraintDiffReport, "markdown">): string {
  const lines = [
    "# Constraint Shadow Diff",
    "",
    "## Summary",
    "",
    `- total sources: ${report.summary.totalSources}`,
    `- mapped sources: ${report.summary.mappedSources}`,
    `- unmapped sources: ${report.summary.unmappedSources}`,
    `- constraints: ${report.summary.constraints}`,
    `- exclusions: ${report.summary.exclusions}`,
    `- unresolved: ${report.summary.unresolved}`,
    `- validation status: ${report.summary.validationStatus}`,
    "",
    "## Rows",
    "",
    "| Source | Category | Disposition | Target | Reason |",
    "|---|---|---|---|---|",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.sourceRecordId} | ${row.category} | ${row.disposition} | ${row.targetId ?? ""} | ${row.reason ?? ""} |`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function createConstraintDiffReport(
  sources: ConstraintSourceRecord[],
  decision: ValidatedConstraintCompilerDecision,
): ConstraintDiffReport {
  const legacySources = legacySourcesOnly(sources).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const rows: ConstraintDiffRow[] = legacySources.map((source) => ({
    sourceRecordId: source.sourceId,
    ...categoryForSource(source, decision),
  }));
  const unmappedSources = rows.filter((row) => row.category === "missing_mapping" && row.reason === "no mapping").length;
  const notMemory = rows.filter((row) => row.category === "exclude_not_memory_settings" || row.category === "exclude_not_memory_tool_contract").length;
  const conflicts = rows.filter((row) => row.category === "mark_conflict").length;
  const archivedObserved = rows.filter((row) => row.category === "legacy_archived_observed").length;
  const reportWithoutMarkdown: Omit<ConstraintDiffReport, "markdown"> = {
    schemaVersion: "constraint-shadow-diff/v1",
    summary: {
      totalSources: legacySources.length,
      mappedSources: legacySources.length - unmappedSources,
      unmappedSources,
      constraints: decision.constraints.length,
      exclusions: decision.exclusions.length,
      unresolved: decision.unresolved.length,
      rescopeProposals: decision.rescopeProposals.length,
      notMemory,
      conflicts,
      archivedObserved,
      validationStatus: unmappedSources === 0 ? "valid" : "invalid",
    },
    rows,
  };
  return { ...reportWithoutMarkdown, markdown: renderDiffMarkdown(reportWithoutMarkdown) };
}
