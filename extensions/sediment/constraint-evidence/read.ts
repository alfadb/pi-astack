import { makeConstraintEvidenceDiagnostic } from "./diagnostics";
import {
  constraintEvidenceBodyHash,
  constraintEvidenceEventPath,
  constraintEvidenceEventRelativePath,
  isSha256Hex,
} from "./hash-envelope";
import {
  CONSTRAINT_EVIDENCE_CANONICALIZATION,
  CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
  CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
  CONSTRAINT_EVIDENCE_HASH_ALG,
  type ConstraintEvidenceDiagnostic,
  type ConstraintEvidenceEnvelopeV1,
  type ConstraintEvidenceEventBodyV1,
  type ConstraintEvidenceEventType,
  type ConstraintEvidenceValidationResult,
} from "./types";

const EVENT_TYPES: ConstraintEvidenceEventType[] = [
  "constraint_signal_observed",
  "constraint_correction_observed",
  "constraint_rejection_observed",
  "constraint_forget_observed",
  "constraint_retract_observed",
  "constraint_not_memory_observed",
  "constraint_unclassified_observed",
];

export interface ConstraintEvidenceReadOptions {
  abrainHome?: string;
  filePath?: string;
  relativePath?: string;
}

export function parseConstraintEvidenceEnvelopeJson(input: string, options: ConstraintEvidenceReadOptions = {}): ConstraintEvidenceValidationResult<ConstraintEvidenceEnvelopeV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return invalid("CE_EVENT_READER_INVALID", "constraint evidence envelope is not valid JSON", [], { error: err instanceof Error ? err.message : String(err) });
  }
  return validateConstraintEvidenceEnvelope(parsed, options);
}

export function validateConstraintEvidenceEnvelope(input: unknown, options: ConstraintEvidenceReadOptions = {}): ConstraintEvidenceValidationResult<ConstraintEvidenceEnvelopeV1> {
  const diagnostics: ConstraintEvidenceDiagnostic[] = [];
  if (!isRecord(input)) {
    return invalid("CE_EVENT_READER_INVALID", "constraint evidence envelope must be an object");
  }

  const eventId = typeof input.event_id === "string" ? input.event_id : undefined;
  if (eventId && !isSha256Hex(eventId)) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_HASH_ENVELOPE_MISMATCH",
      message: "constraint evidence event_id is not a sha256 hex string",
      eventIds: [eventId],
    }));
  }

  if (input.schema !== CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_SCHEMA_UNSUPPORTED",
      message: "constraint evidence envelope schema is unsupported",
      eventIds: eventId ? [eventId] : [],
      data: { expected: CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION, actual: input.schema },
    }));
  }
  if (input.canonicalization !== CONSTRAINT_EVIDENCE_CANONICALIZATION || input.hash_alg !== CONSTRAINT_EVIDENCE_HASH_ALG) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_HASH_ENVELOPE_MISMATCH",
      message: "constraint evidence envelope hash metadata is unsupported",
      eventIds: eventId ? [eventId] : [],
      data: {
        expectedCanonicalization: CONSTRAINT_EVIDENCE_CANONICALIZATION,
        actualCanonicalization: input.canonicalization,
        expectedHashAlg: CONSTRAINT_EVIDENCE_HASH_ALG,
        actualHashAlg: input.hash_alg,
      },
    }));
  }
  if (typeof input.body_hash !== "string" || !isSha256Hex(input.body_hash)) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_HASH_ENVELOPE_MISMATCH",
      message: "constraint evidence body_hash is not a sha256 hex string",
      eventIds: eventId ? [eventId] : [],
    }));
  }
  if (eventId && typeof input.body_hash === "string" && input.body_hash !== eventId) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_HASH_ENVELOPE_MISMATCH",
      message: "constraint evidence event_id does not match body_hash",
      eventIds: [eventId],
      data: { bodyHash: input.body_hash },
    }));
  }

  const bodyResult = validateConstraintEvidenceBody(input.body, eventId ? [eventId] : []);
  diagnostics.push(...bodyResult.diagnostics);
  if (bodyResult.ok && eventId && isSha256Hex(input.body_hash)) {
    const computedBodyHash = constraintEvidenceBodyHash(bodyResult.value);
    if (computedBodyHash !== input.body_hash) {
      diagnostics.push(makeConstraintEvidenceDiagnostic({
        code: "CE_HASH_ENVELOPE_MISMATCH",
        message: "constraint evidence body hash does not match body",
        eventIds: [eventId],
        data: { expected: input.body_hash, actual: computedBodyHash },
      }));
    }
  }

  if (eventId) {
    const expectedRelativePath = constraintEvidenceEventRelativePath(eventId);
    const normalizedRelativePath = options.relativePath?.split(/[\\/]+/).join("/");
    if (normalizedRelativePath && normalizedRelativePath !== expectedRelativePath) {
      diagnostics.push(makeConstraintEvidenceDiagnostic({
        code: "CE_HASH_PATH_MISMATCH",
        message: "constraint evidence file path does not match event id",
        eventIds: [eventId],
        data: { expected: expectedRelativePath, actual: normalizedRelativePath },
      }));
    }
    if (options.abrainHome && options.filePath) {
      const expectedPath = constraintEvidenceEventPath(options.abrainHome, eventId);
      const actualPath = options.filePath.replace(/\\/g, "/");
      if (actualPath !== expectedPath) {
        diagnostics.push(makeConstraintEvidenceDiagnostic({
          code: "CE_HASH_PATH_MISMATCH",
          message: "constraint evidence absolute file path does not match event id",
          eventIds: [eventId],
          data: { expected: expectedPath, actual: actualPath },
        }));
      }
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: input as unknown as ConstraintEvidenceEnvelopeV1,
    diagnostics,
  };
}

function validateConstraintEvidenceBody(input: unknown, eventIds: string[]): ConstraintEvidenceValidationResult<ConstraintEvidenceEventBodyV1> {
  const diagnostics: ConstraintEvidenceDiagnostic[] = [];
  if (!isRecord(input)) {
    return invalid("CE_EVENT_READER_INVALID", "constraint evidence body must be an object", eventIds);
  }
  if (input.event_schema_version !== CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_SCHEMA_UNSUPPORTED",
      message: "constraint evidence event schema is unsupported",
      eventIds,
      data: { expected: CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION, actual: input.event_schema_version },
    }));
  }
  if (!EVENT_TYPES.includes(input.event_type as ConstraintEvidenceEventType)) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_EVENT_READER_INVALID",
      message: "constraint evidence event_type is unsupported",
      eventIds,
      data: { actual: input.event_type },
    }));
  }
  for (const field of ["created_at_utc", "device_id", "session_id", "turn_id"] as const) {
    if (typeof input[field] !== "string" || !input[field]) {
      diagnostics.push(makeConstraintEvidenceDiagnostic({
        code: "CE_EVENT_READER_INVALID",
        message: `constraint evidence body missing required string field ${field}`,
        eventIds,
      }));
    }
  }
  if (typeof input.device_event_seq !== "number" && typeof input.producer_nonce !== "string") {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_EVENT_READER_INVALID",
      message: "constraint evidence body requires device_event_seq or producer_nonce",
      eventIds,
    }));
  }
  if (!Array.isArray(input.causal_parents) || !input.causal_parents.every((item) => typeof item === "string")) {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_EVENT_READER_INVALID",
      message: "constraint evidence causal_parents must be a string array",
      eventIds,
    }));
  }
  for (const field of ["actor", "source", "intent", "payload", "scope", "sanitizer", "neighbor_summary", "producer"] as const) {
    if (!isRecord(input[field])) {
      diagnostics.push(makeConstraintEvidenceDiagnostic({
        code: "CE_EVENT_READER_INVALID",
        message: `constraint evidence body missing required object field ${field}`,
        eventIds,
      }));
    }
  }
  if (isRecord(input.sanitizer) && input.sanitizer.status === "blocked") {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_SANITIZER_BLOCKED",
      message: "constraint evidence sanitizer blocked this signal",
      eventIds,
    }));
  }
  if (isRecord(input.intent) && input.intent.operation_hint === "not_memory") {
    const hint = isRecord(input.payload) ? input.payload.not_memory_hint : undefined;
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: hint === "tool_contract" ? "CE_NOT_MEMORY_TOOL_CONTRACT" : "CE_NOT_MEMORY_SETTINGS",
      message: "constraint evidence signal is marked as not-memory",
      eventIds,
      data: { hint },
    }));
  }
  if (isRecord(input.scope) && isRecord(input.scope.scope_hint) && input.scope.scope_hint.kind === "unknown") {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_SCOPE_AMBIGUOUS",
      message: "constraint evidence scope hint is unknown",
      eventIds,
      data: { reason: input.scope.scope_hint.reason },
    }));
  }
  if (input.event_type === "constraint_unclassified_observed") {
    diagnostics.push(makeConstraintEvidenceDiagnostic({
      code: "CE_UNCLASSIFIED",
      message: "constraint evidence signal is unclassified",
      eventIds,
    }));
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { ok: false, diagnostics };
  return { ok: true, value: input as unknown as ConstraintEvidenceEventBodyV1, diagnostics };
}

function invalid(code: ConstraintEvidenceDiagnostic["code"], message: string, eventIds: string[] = [], data?: Record<string, unknown>): ConstraintEvidenceValidationResult<never> {
  return {
    ok: false,
    diagnostics: [makeConstraintEvidenceDiagnostic({ code, message, eventIds, data })],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
