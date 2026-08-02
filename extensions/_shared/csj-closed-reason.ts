/**
 * CSJ closed reason adapter (spec §8.4).
 * External surfaces may only observe reason_code + counts/bools.
 * Existing detail / OID / path / stack is discarded at the boundary.
 */

export const CSJ_CLOSED_REASONS = Object.freeze([
  "eligible_false",
  "open_not_unique",
  "published_nonzero",
  "antichain_false",
  "cert_failed",
  "cert_f_failed",
  "shape_or_operation_failed",
  "object_missing",
  "index_or_fingerprint_failed",
  "bind_intent_mismatch",
  "cas_race",
  "authority_revoked",
  "barrier_not_held",
  "purpose_invalid",
  "artifact_mismatch",
  "post_cas_recover_failed",
  "t2_budget_exhausted",
  "journal_diagnostic_only",
  "internal_error",
  "none",
] as const);

export type CsjClosedReason = (typeof CSJ_CLOSED_REASONS)[number];

export interface CsjClosedSurface {
  readonly reason_code: CsjClosedReason;
  readonly counts?: Readonly<Record<string, number>>;
  readonly flags?: Readonly<Record<string, boolean>>;
}

const CLOSED_SET = new Set<string>(CSJ_CLOSED_REASONS);

export function isCsjClosedReason(value: unknown): value is CsjClosedReason {
  return typeof value === "string" && CLOSED_SET.has(value);
}

export function adaptCsjClosedReason(input: {
  reason?: CsjClosedReason | string | null;
  code?: string | null;
  counts?: Readonly<Record<string, number>>;
  flags?: Readonly<Record<string, boolean>>;
  /** Intentionally discarded — never forwarded. */
  detail?: unknown;
  message?: unknown;
  stack?: unknown;
}): CsjClosedSurface {
  void input.detail;
  void input.message;
  void input.stack;
  const candidate = input.reason ?? mapCodeToReason(input.code);
  const reason_code: CsjClosedReason = isCsjClosedReason(candidate) ? candidate : "internal_error";
  const counts = sanitizeNumberMap(input.counts);
  const flags = sanitizeBoolMap(input.flags);
  return Object.freeze({
    reason_code,
    ...(counts ? { counts: Object.freeze(counts) } : {}),
    ...(flags ? { flags: Object.freeze(flags) } : {}),
  });
}

function mapCodeToReason(code: string | null | undefined): CsjClosedReason {
  if (!code) return "internal_error";
  switch (code) {
    case "CSJ_ELIGIBLE_FALSE":
    case "CSJ_ELIGIBILITY_FALSE":
      return "eligible_false";
    case "CSJ_OPEN_NOT_UNIQUE":
    case "RECOVERY_OPEN_NOT_UNIQUE":
      return "open_not_unique";
    case "CSJ_PUBLISHED_NONZERO":
    case "RECOVERY_PUBLISHED_REF_DIVERGED":
      return "published_nonzero";
    case "CSJ_ANTICHAIN_FALSE":
      return "antichain_false";
    case "CSJ_CERT_FAILED":
    case "RECOVERY_SEMANTIC_JOIN_MISSING":
      return "cert_failed";
    case "CSJ_CERT_F_FAILED":
      return "cert_f_failed";
    case "CSJ_SHAPE_OR_OPERATION_FAILED":
    case "RECOVERY_CANDIDATE_INVALID":
      return "shape_or_operation_failed";
    case "CSJ_OBJECT_MISSING":
      return "object_missing";
    case "CSJ_INDEX_OR_FINGERPRINT_FAILED":
      return "index_or_fingerprint_failed";
    case "CSJ_BIND_INTENT_MISMATCH":
      return "bind_intent_mismatch";
    case "CSJ_CAS_RACE":
    case "cas_conflict":
      return "cas_race";
    case "CSJ_AUTHORITY_REVOKED":
    case "canonical_mutation_not_authorized":
    case "CANONICAL_MUTATION_NOT_AUTHORIZED":
      return "authority_revoked";
    case "CSJ_BARRIER_NOT_HELD":
    case "CANONICAL_MUTATION_LOCK_REQUIRED":
      return "barrier_not_held";
    case "CSJ_PURPOSE_INVALID":
    case "REF_MOVE_PURPOSE_INVALID":
      return "purpose_invalid";
    case "CSJ_ARTIFACT_MISMATCH":
      return "artifact_mismatch";
    case "CSJ_POST_CAS_RECOVER_FAILED":
      return "post_cas_recover_failed";
    case "CSJ_T2_BUDGET_EXHAUSTED":
    case "RECOVERY_V3_LIVENESS":
      return "t2_budget_exhausted";
    case "none":
    case "CSJ_NONE":
      return "none";
    default:
      return "internal_error";
  }
}

function sanitizeNumberMap(input: Readonly<Record<string, number>> | undefined): Record<string, number> | undefined {
  if (!input) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeBoolMap(input: Readonly<Record<string, boolean>> | undefined): Record<string, boolean> | undefined {
  if (!input) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value !== "boolean") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}
