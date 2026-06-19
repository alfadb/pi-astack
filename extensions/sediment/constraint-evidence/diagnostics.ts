import type {
  ConstraintEvidenceDiagnostic,
  ConstraintEvidenceDiagnosticCode,
  ConstraintEvidenceDiagnosticConsumer,
  ConstraintEvidenceDiagnosticSeverity,
} from "./types";

export const CONSTRAINT_EVIDENCE_DIAGNOSTIC_CONSUMERS: Record<ConstraintEvidenceDiagnosticCode, ConstraintEvidenceDiagnosticConsumer[]> = {
  CE_APPEND_OK: ["event_audit"],
  CE_APPEND_FAILED: ["event_audit", "manual_investigation"],
  CE_APPEND_RETRY_PENDING: ["event_audit"],
  CE_APPEND_IDEMPOTENT_DUPLICATE: ["event_audit"],
  CE_HASH_ENVELOPE_MISMATCH: ["event_audit", "manual_investigation"],
  CE_HASH_PATH_MISMATCH: ["event_audit", "manual_investigation"],
  CE_HASH_PATH_COLLISION: ["event_audit", "manual_investigation"],
  CE_SCHEMA_UNSUPPORTED: ["manual_investigation"],
  CE_SANITIZER_BLOCKED: ["event_audit", "manual_investigation"],
  CE_NOT_MEMORY_SETTINGS: ["not_memory_audit"],
  CE_NOT_MEMORY_TOOL_CONTRACT: ["not_memory_audit"],
  CE_SCOPE_AMBIGUOUS: ["scope_review"],
  CE_UNCLASSIFIED: ["manual_investigation"],
  CE_LEGACY_PARALLEL_DELTA: ["event_audit", "manual_investigation"],
  CE_COMPILER_STALE: ["compiler_liveness_report"],
  CE_COMPILER_DRAIN_OK: ["compiler_liveness_report"],
  CE_EVENT_READER_INVALID: ["event_audit", "manual_investigation"],
  CE_EVENT_LOSS_DETECTED: ["event_audit", "manual_investigation"],
  CE_EVENT_NOT_MEMORY_LEAK: ["not_memory_audit", "p3_injection_readiness"],
  CE_EVENT_SCOPE_CONSERVATISM_BREACH: ["scope_review", "p3_injection_readiness"],
};

const DEFAULT_SEVERITY: Record<ConstraintEvidenceDiagnosticCode, ConstraintEvidenceDiagnosticSeverity> = {
  CE_APPEND_OK: "info",
  CE_APPEND_FAILED: "error",
  CE_APPEND_RETRY_PENDING: "warning",
  CE_APPEND_IDEMPOTENT_DUPLICATE: "info",
  CE_HASH_ENVELOPE_MISMATCH: "error",
  CE_HASH_PATH_MISMATCH: "error",
  CE_HASH_PATH_COLLISION: "error",
  CE_SCHEMA_UNSUPPORTED: "error",
  CE_SANITIZER_BLOCKED: "warning",
  CE_NOT_MEMORY_SETTINGS: "info",
  CE_NOT_MEMORY_TOOL_CONTRACT: "info",
  CE_SCOPE_AMBIGUOUS: "warning",
  CE_UNCLASSIFIED: "warning",
  CE_LEGACY_PARALLEL_DELTA: "warning",
  CE_COMPILER_STALE: "warning",
  CE_COMPILER_DRAIN_OK: "info",
  CE_EVENT_READER_INVALID: "error",
  CE_EVENT_LOSS_DETECTED: "error",
  CE_EVENT_NOT_MEMORY_LEAK: "error",
  CE_EVENT_SCOPE_CONSERVATISM_BREACH: "error",
};

export function constraintEvidenceDiagnosticId(code: ConstraintEvidenceDiagnosticCode, eventIds: string[] = [], message = ""): string {
  const eventPart = eventIds.slice().sort().join("+") || "none";
  const messagePart = message.trim().toLowerCase().replace(/[^a-z0-9一-龥]+/giu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "diagnostic";
  return `${code}:${eventPart}:${messagePart}`;
}

export function makeConstraintEvidenceDiagnostic(input: {
  code: ConstraintEvidenceDiagnosticCode;
  message: string;
  eventIds?: string[];
  severity?: ConstraintEvidenceDiagnosticSeverity;
  consumers?: ConstraintEvidenceDiagnosticConsumer[];
  data?: Record<string, unknown>;
}): ConstraintEvidenceDiagnostic {
  const eventIds = input.eventIds?.slice().sort() ?? [];
  const consumers = input.consumers?.length ? input.consumers : CONSTRAINT_EVIDENCE_DIAGNOSTIC_CONSUMERS[input.code];
  return {
    id: constraintEvidenceDiagnosticId(input.code, eventIds, input.message),
    code: input.code,
    severity: input.severity ?? DEFAULT_SEVERITY[input.code],
    message: input.message,
    eventIds,
    consumers,
    ...(input.data ? { data: input.data } : {}),
  };
}

export function assertConstraintEvidenceDiagnosticConsumers(diagnostics: ConstraintEvidenceDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (!diagnostic.consumers.length) {
      throw new Error(`constraint evidence diagnostic ${diagnostic.id} has no consumer`);
    }
  }
}
