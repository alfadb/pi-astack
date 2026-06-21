import type {
  ConstraintShadowDiagnostic,
  ConstraintShadowDiagnosticCode,
  ConstraintShadowDiagnosticConsumer,
  ConstraintShadowDiagnosticSeverity,
} from "./types";

export const DIAGNOSTIC_CONSUMERS: Record<ConstraintShadowDiagnosticCode, ConstraintShadowDiagnosticConsumer[]> = {
  SC_INPUT_MALFORMED_RULE: ["diff_report", "manual_investigation"],
  SC_INPUT_MISSING_LEGACY_REF: ["diff_report", "manual_investigation"],
  SC_INPUT_BODY_HASH_MISMATCH: ["diff_report", "manual_investigation"],
  SC_AUDIT_TRUNCATED: ["diff_report", "manual_investigation"],
  SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS: ["diff_report", "manual_investigation"],
  SC_SCOPE_AMBIGUOUS: ["scope_review"],
  SC_SCOPE_RESCOPE_PROPOSED: ["scope_review"],
  SC_NOT_MEMORY_SETTINGS: ["not_memory_audit"],
  SC_NOT_MEMORY_TOOL_CONTRACT: ["not_memory_audit"],
  SC_NEAR_DUPLICATE_GROUP: ["diff_report"],
  SC_CONFLICT_DETECTED: ["diff_report"],
  SC_COMPACT_REQUIRED: ["diff_report"],
  SC_ARCHIVED_REACTIVATION_RISK: ["diff_report", "manual_investigation"],
  SC_LEGACY_INJECTION_DELTA: ["diff_report"],
  SC_RENDER_DRIFT: ["compiler_prompt_iteration"],
  SC_COMPILER_MODEL_UNAVAILABLE: ["compiler_prompt_iteration"],
  SC_COMPILER_PARSE_FAILED: ["compiler_prompt_iteration"],
  SC_COMPILER_VALIDATION_FAILED: ["compiler_prompt_iteration", "manual_investigation"],
  SC_COMPILER_ITEM_REJECTED: ["compiler_prompt_iteration", "scope_review", "manual_investigation"],
  SC_SHADOW_ONLY_VIOLATION_ATTEMPT: ["manual_investigation"],
  SC_UNCLASSIFIED: ["compiler_prompt_iteration"],
  SC_EVENT_READ_ERROR: ["manual_investigation", "compiler_liveness_report"],
  SC_EVENT_COVERAGE_GAP: ["compiler_liveness_report", "p3_injection_readiness"],
  SC_EVENT_STALE_THRESHOLD: ["compiler_liveness_report", "p3_injection_readiness"],
  SC_LEGACY_PARALLEL_DELTA: ["diff_report", "p3_injection_readiness"],
  SC_EVENT_NOT_MEMORY_LEAK: ["not_memory_audit", "p3_injection_readiness"],
  SC_EVENT_SCOPE_BREACH: ["scope_review", "p3_injection_readiness"],
  SC_L2_WRITE_FAILED: ["manual_investigation"],
};

const DEFAULT_SEVERITY: Record<ConstraintShadowDiagnosticCode, ConstraintShadowDiagnosticSeverity> = {
  SC_INPUT_MALFORMED_RULE: "error",
  SC_INPUT_MISSING_LEGACY_REF: "warning",
  SC_INPUT_BODY_HASH_MISMATCH: "warning",
  SC_AUDIT_TRUNCATED: "warning",
  SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS: "error",
  SC_SCOPE_AMBIGUOUS: "warning",
  SC_SCOPE_RESCOPE_PROPOSED: "info",
  SC_NOT_MEMORY_SETTINGS: "info",
  SC_NOT_MEMORY_TOOL_CONTRACT: "info",
  SC_NEAR_DUPLICATE_GROUP: "info",
  SC_CONFLICT_DETECTED: "warning",
  SC_COMPACT_REQUIRED: "info",
  SC_ARCHIVED_REACTIVATION_RISK: "warning",
  SC_LEGACY_INJECTION_DELTA: "info",
  SC_RENDER_DRIFT: "warning",
  SC_COMPILER_MODEL_UNAVAILABLE: "error",
  SC_COMPILER_PARSE_FAILED: "error",
  SC_COMPILER_VALIDATION_FAILED: "error",
  SC_COMPILER_ITEM_REJECTED: "warning",
  SC_SHADOW_ONLY_VIOLATION_ATTEMPT: "error",
  SC_UNCLASSIFIED: "warning",
  SC_EVENT_READ_ERROR: "error",
  SC_EVENT_COVERAGE_GAP: "warning",
  SC_EVENT_STALE_THRESHOLD: "warning",
  SC_LEGACY_PARALLEL_DELTA: "info",
  SC_EVENT_NOT_MEMORY_LEAK: "error",
  SC_EVENT_SCOPE_BREACH: "error",
  SC_L2_WRITE_FAILED: "error",
};

export function diagnosticId(code: ConstraintShadowDiagnosticCode, sourceRecordIds: string[] = [], message = ""): string {
  const sourcePart = sourceRecordIds.slice().sort().join("+") || "none";
  const messagePart = message.trim().toLowerCase().replace(/[^a-z0-9一-龥]+/giu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "diagnostic";
  return `${code}:${sourcePart}:${messagePart}`;
}

export function makeDiagnostic(input: {
  code: ConstraintShadowDiagnosticCode;
  message: string;
  sourceRecordIds?: string[];
  severity?: ConstraintShadowDiagnosticSeverity;
  consumers?: ConstraintShadowDiagnosticConsumer[];
  data?: Record<string, unknown>;
}): ConstraintShadowDiagnostic {
  const sourceRecordIds = input.sourceRecordIds?.slice().sort() ?? [];
  const consumers = input.consumers?.length ? input.consumers : DIAGNOSTIC_CONSUMERS[input.code];
  return {
    id: diagnosticId(input.code, sourceRecordIds, input.message),
    code: input.code,
    severity: input.severity ?? DEFAULT_SEVERITY[input.code],
    message: input.message,
    sourceRecordIds,
    consumers,
    ...(input.data ? { data: input.data } : {}),
  };
}

export function assertDiagnosticConsumers(diagnostics: ConstraintShadowDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (!diagnostic.consumers.length) {
      throw new Error(`diagnostic ${diagnostic.id} has no consumer`);
    }
  }
}
