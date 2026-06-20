import { sha256Hex } from "./normalize";
import type {
  ConstraintDiffCategory,
  ConstraintDiffReport,
  ConstraintDiffRow,
  ConstraintScope,
  LegacyRuleStatus,
} from "./types";

// ADR0039 Constraint P5 corpus-split shadow (4×T0 unanimous v4, 2026-06-20).
// PURE RE-PROJECTION over the existing ConstraintDiffReport. This module reads
// ONLY the diff report (no decision, no sources, no LLM, no legacy-scan). The
// stratum is a deterministic many-to-one fold over the existing
// ConstraintDiffCategory (the single source of truth) + the row's scope. There
// is NO new classification, NO keyword/tool-name/project-name matching (§12),
// NO canonical mutation. Coverage is already guaranteed upstream by
// validate-decision.ts (every source has a primary disposition or it throws);
// the Σ assertion here is a view-level defense-in-depth that fails closed in the
// view only and never throws into the compiler.

const VIEW_SCHEMA_VERSION = "constraint-corpus-split/v1";

export type CorpusSplitStratum =
  | "compiled_global"
  | "compiled_project"
  | "settings_not_memory"
  | "tool_contract_not_memory"
  | "knowledge_candidate"
  | "conflict_unresolved"
  | "archived"
  | "needs_attention";

// Fixed presentation order (deterministic).
export const CORPUS_SPLIT_STRATA: readonly CorpusSplitStratum[] = [
  "compiled_global",
  "compiled_project",
  "settings_not_memory",
  "tool_contract_not_memory",
  "knowledge_candidate",
  "conflict_unresolved",
  "archived",
  "needs_attention",
] as const;

// Route-elsewhere strata are PROPOSALS that this shadow does NOT apply (the
// actual rescope / settings-tool routing / knowledge migration are separate
// gated shards). The note is data-derived, not a content match.
const STRATUM_PROPOSAL_NOTE: Partial<Record<CorpusSplitStratum, string>> = {
  compiled_project: "includes global→project rescope PROPOSALs (not applied)",
  settings_not_memory: "PROPOSAL — belongs in settings/config (not applied)",
  tool_contract_not_memory: "PROPOSAL — belongs in tool declaration (not applied)",
  knowledge_candidate: "PROPOSAL — migrate to Knowledge domain (not applied)",
  needs_attention: "compiler emitted only a diagnostic; surfaced for review",
};

// stratum = pure function of (existing diff category, row scope). The TS
// never-default makes this a COMPILE-TIME exhaustiveness guard: a future
// ConstraintDiffCategory value MUST be mapped here explicitly or the build
// fails — nothing is silently dropped into a default bucket (§12 / no-silent-loss).
export function stratumForRow(category: ConstraintDiffCategory, scope: ConstraintScope): CorpusSplitStratum {
  switch (category) {
    case "kept":
    case "compact":
    case "merge_near_duplicates":
      return scope.kind === "global" ? "compiled_global" : "compiled_project";
    case "rescope_global_to_project":
      return "compiled_project";
    case "rescope_project_to_global":
      return "compiled_global";
    case "exclude_not_memory_settings":
      return "settings_not_memory";
    case "exclude_not_memory_tool_contract":
      return "tool_contract_not_memory";
    case "split_knowledge_candidate":
      return "knowledge_candidate";
    case "mark_conflict":
    case "keep_unresolved":
      return "conflict_unresolved";
    case "legacy_archived_observed":
      return "archived";
    case "missing_mapping":
      return "needs_attention";
    default: {
      const exhaustive: never = category;
      throw new Error(`constraint corpus-split: unmapped ConstraintDiffCategory ${String(exhaustive)}`);
    }
  }
}

export interface CorpusSplitRow {
  sourceRecordId: string;
  stratum: CorpusSplitStratum;
  category: ConstraintDiffCategory;
  scope: ConstraintScope;
  sourceStatus: LegacyRuleStatus;
  reason?: string;
  targetId?: string;
}

export interface CorpusSplitManifest {
  schemaVersion: typeof VIEW_SCHEMA_VERSION;
  shadowOnly: true;
  inputRootHash: string;
  diffValidationStatus: "valid" | "invalid";
  totalSources: number;
  coverageOk: boolean;
  needsAttention: number;
  counts: Record<CorpusSplitStratum, number>;
  rows: CorpusSplitRow[];
  outputHash: string;
}

export interface CorpusSplitReport {
  manifest: CorpusSplitManifest;
  markdown: string;
}

function cmpCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyCounts(): Record<CorpusSplitStratum, number> {
  const counts = {} as Record<CorpusSplitStratum, number>;
  for (const stratum of CORPUS_SPLIT_STRATA) counts[stratum] = 0;
  return counts;
}

function toCorpusRow(row: ConstraintDiffRow): CorpusSplitRow {
  return {
    sourceRecordId: row.sourceRecordId,
    stratum: stratumForRow(row.category, row.scope),
    category: row.category,
    scope: row.scope,
    sourceStatus: row.sourceStatus,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.targetId ? { targetId: row.targetId } : {}),
  };
}

export function buildCorpusSplitReport(report: ConstraintDiffReport, options: { inputRootHash: string }): CorpusSplitReport {
  const rows = report.rows
    .map(toCorpusRow)
    .sort((left, right) => cmpCodepoint(left.sourceRecordId, right.sourceRecordId));
  const counts = emptyCounts();
  for (const row of rows) counts[row.stratum] += 1;
  const stratumSum = CORPUS_SPLIT_STRATA.reduce((sum, stratum) => sum + counts[stratum], 0);
  // View-level Σ defense-in-depth: every row maps to exactly one stratum
  // (stratumForRow is total), so stratumSum === rows.length by construction;
  // coverageOk only goes false on a re-projection bug, never on row content.
  const coverageOk = stratumSum === rows.length && rows.length === report.summary.totalSources;
  const manifestNoHash: Omit<CorpusSplitManifest, "outputHash"> = {
    schemaVersion: VIEW_SCHEMA_VERSION,
    shadowOnly: true,
    inputRootHash: options.inputRootHash,
    diffValidationStatus: report.summary.validationStatus,
    totalSources: report.summary.totalSources,
    coverageOk,
    needsAttention: counts.needs_attention,
    counts,
    rows,
  };
  const markdown = renderCorpusSplitMarkdown(manifestNoHash);
  const outputHash = sha256Hex(markdown.replace("output_hash: __PENDING__", "output_hash: "));
  return {
    manifest: { ...manifestNoHash, outputHash },
    markdown: markdown.replace("output_hash: __PENDING__", `output_hash: ${outputHash}`),
  };
}

function renderCorpusSplitMarkdown(manifest: Omit<CorpusSplitManifest, "outputHash">): string {
  const lines: string[] = [
    "---",
    `schema_version: ${VIEW_SCHEMA_VERSION}`,
    "view: constraint_corpus_split",
    "projector: constraint-corpus-split",
    `input_root_hash: ${manifest.inputRootHash}`,
    `diff_validation_status: ${manifest.diffValidationStatus}`,
    `total_sources: ${manifest.totalSources}`,
    `coverage_ok: ${manifest.coverageOk}`,
    `needs_attention: ${manifest.needsAttention}`,
    "output_hash: __PENDING__",
    "shadow_only: true",
    "---",
    "",
    "# Constraint Corpus Split (Shadow)",
    "",
    "> PROPOSAL — not applied. This is a deterministic shadow re-projection of the",
    "> constraint diff; no rescope / settings-tool routing / knowledge migration /",
    "> archive action is performed here. Each action is a separate gated shard.",
    "",
    "## Summary",
    "",
    `- total sources: ${manifest.totalSources}`,
    `- coverage_ok (\u03a3 strata == total): ${manifest.coverageOk}`,
    `- needs_attention: ${manifest.needsAttention}`,
  ];
  for (const stratum of CORPUS_SPLIT_STRATA) {
    const note = STRATUM_PROPOSAL_NOTE[stratum];
    lines.push(`- ${stratum}: ${manifest.counts[stratum]}${note ? ` (${note})` : ""}`);
  }
  for (const stratum of CORPUS_SPLIT_STRATA) {
    const note = STRATUM_PROPOSAL_NOTE[stratum];
    lines.push("", `## ${stratum} (${manifest.counts[stratum]})${note ? ` — ${note}` : ""}`, "");
    const stratumRows = manifest.rows.filter((row) => row.stratum === stratum);
    if (!stratumRows.length) {
      lines.push("_(none)_");
      continue;
    }
    for (const row of stratumRows) {
      const status = row.sourceStatus !== "active" ? ` [status:${row.sourceStatus}]` : "";
      const reason = row.reason ? ` — ${row.reason}` : "";
      lines.push(`- \`${row.sourceRecordId}\` [${row.category}]${status}${reason}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
