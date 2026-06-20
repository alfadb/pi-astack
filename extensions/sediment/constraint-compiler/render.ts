import type {
  ConstraintDecisionExclusion,
  ConstraintDecisionUnresolved,
  RenderedConstraintView,
  ValidatedConstraint,
  ValidatedConstraintCompilerDecision,
} from "./types";
import { sha256Hex, stableCanonicalize } from "./normalize";

const TEMPLATE_VERSION = "constraint-shadow-render/v1";

// ADR0039 §4.3 strict determinism: locale-independent codepoint ordering so the
// same decision renders byte-identical L2 on any machine/locale. Keys are ASCII
// today, but L2 reconcile byte-compare must not silently depend on that.
function cmpCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scopeSortKey(constraint: ValidatedConstraint): string {
  const scopePart = constraint.scope.kind === "global" ? "0:global" : `1:${constraint.scope.projectId}`;
  const injectPart = constraint.injectMode === "always" ? "0:always" : "1:listed";
  const priority = 999 - (constraint.priorityHint ?? 0);
  return `${scopePart}\0${injectPart}\0${String(priority).padStart(4, "0")}\0${constraint.title}\0${constraint.constraintId}`;
}

function scopeHeading(constraint: ValidatedConstraint): string {
  if (constraint.scope.kind === "global") return constraint.injectMode === "always" ? "Global always" : "Global listed";
  return `Project ${constraint.scope.projectId} ${constraint.injectMode}`;
}

function listLine(label: string, value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.length ? [`- ${label}: ${value.join(", ")}`] : [];
  return value?.trim() ? [`- ${label}: ${value.trim()}`] : [];
}

function renderConstraint(constraint: ValidatedConstraint): string[] {
  return [
    `### ${constraint.title}`,
    "",
    ...listLine("id", constraint.constraintId),
    ...listLine("source refs", constraint.sourceRecordIds.slice().sort()),
    ...listLine("must do", constraint.mustDoSummary),
    ...listLine("applies when", constraint.appliesWhen),
    ...listLine("trigger phrases", constraint.triggerPhrases?.slice().sort()),
    "",
    constraint.compiledBody.trim(),
    "",
  ];
}

function renderExclusions(exclusions: ConstraintDecisionExclusion[]): string[] {
  if (!exclusions.length) return ["No exclusions.", ""];
  return exclusions
    .slice()
    .sort((left, right) => cmpCodepoint(`${left.reason}:${left.sourceRecordIds.join("+")}`, `${right.reason}:${right.sourceRecordIds.join("+")}`))
    .flatMap((exclusion) => [
      `- ${exclusion.reason}: ${exclusion.sourceRecordIds.slice().sort().join(", ")}${exclusion.note ? ` — ${exclusion.note}` : ""}`,
    ])
    .concat("");
}

function renderUnresolved(unresolved: ConstraintDecisionUnresolved[]): string[] {
  if (!unresolved.length) return ["No unresolved constraints.", ""];
  return unresolved
    .slice()
    .sort((left, right) => cmpCodepoint(`${left.reason}:${left.sourceRecordIds.join("+")}`, `${right.reason}:${right.sourceRecordIds.join("+")}`))
    .flatMap((item) => [
      `- ${item.reason}: ${item.sourceRecordIds.slice().sort().join(", ")}${item.note ? ` — ${item.note}` : ""}`,
    ])
    .concat("");
}

export function renderConstraintShadowView(decision: ValidatedConstraintCompilerDecision): RenderedConstraintView {
  const decisionHash = sha256Hex(stableCanonicalize(decision));
  const grouped = new Map<string, ValidatedConstraint[]>();
  for (const constraint of decision.constraints.slice().sort((left, right) => cmpCodepoint(scopeSortKey(left), scopeSortKey(right)))) {
    const heading = scopeHeading(constraint);
    grouped.set(heading, [...(grouped.get(heading) ?? []), constraint]);
  }

  const lines: string[] = [
    "---",
    "schema_version: constraint-shadow-view/v1",
    "view: compiled_constraint_shadow",
    "projector: constraint-shadow-compiler",
    `template_version: ${TEMPLATE_VERSION}`,
    `input_root_hash: ${decision.inputRootHash}`,
    `decision_hash: ${decisionHash}`,
    "shadow_output_hash: __PENDING__",
    "shadow_only: true",
    "---",
    "",
    "# Compiled Constraint View (Shadow)",
    "",
  ];

  const headings = [
    "Global always",
    "Global listed",
    ...Array.from(grouped.keys()).filter((heading) => heading.startsWith("Project ")).sort(),
  ];
  for (const heading of headings) {
    lines.push(`## ${heading}`, "");
    const constraints = grouped.get(heading) ?? [];
    if (!constraints.length) {
      lines.push("No constraints.", "");
      continue;
    }
    for (const constraint of constraints) lines.push(...renderConstraint(constraint));
  }

  lines.push("## Conflicts", "", ...renderUnresolved(decision.unresolved), "## Not-memory diagnostics", "", ...renderExclusions(decision.exclusions));
  const pendingMarkdown = `${lines.join("\n").trimEnd()}\n`;
  const shadowOutputHash = sha256Hex(pendingMarkdown.replace("shadow_output_hash: __PENDING__", "shadow_output_hash: "));
  const markdown = pendingMarkdown.replace("shadow_output_hash: __PENDING__", `shadow_output_hash: ${shadowOutputHash}`);
  return {
    schemaVersion: "constraint-shadow-view/v1",
    shadowOnly: true,
    inputRootHash: decision.inputRootHash,
    decisionHash,
    shadowOutputHash,
    markdown,
  };
}
