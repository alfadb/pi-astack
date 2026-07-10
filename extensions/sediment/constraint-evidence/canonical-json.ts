import { canonicalizeJcs, normalizeJcsValue } from "../../_shared/jcs";
import type { ConstraintEvidenceJsonValue } from "./types";

export function canonicalJson(value: ConstraintEvidenceJsonValue): string {
  return canonicalizeJcs(value);
}

export function canonicalJsonValue(value: unknown): ConstraintEvidenceJsonValue {
  return normalizeJcsValue(value) as ConstraintEvidenceJsonValue;
}
