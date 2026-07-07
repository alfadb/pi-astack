import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonValue } from "./canonical-json";
import {
  CONSTRAINT_EVIDENCE_CANONICALIZATION,
  CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
  CONSTRAINT_EVIDENCE_HASH_ALG,
  type ConstraintEvidenceEnvelopeV1,
  type ConstraintEvidenceEventBodyV1,
} from "./types";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function constraintEvidenceBodyHash(body: ConstraintEvidenceEventBodyV1): string {
  return sha256Hex(canonicalJson(canonicalJsonValue(body)));
}

export function createConstraintEvidenceEnvelope<TBody extends ConstraintEvidenceEventBodyV1>(body: TBody): ConstraintEvidenceEnvelopeV1<TBody> {
  const bodyHash = constraintEvidenceBodyHash(body);
  return {
    schema: CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
    canonicalization: CONSTRAINT_EVIDENCE_CANONICALIZATION,
    hash_alg: CONSTRAINT_EVIDENCE_HASH_ALG,
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

export function constraintEvidenceEnvelopeJson(envelope: ConstraintEvidenceEnvelopeV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function constraintEvidenceEventRelativePath(eventId: string): string {
  if (!isSha256Hex(eventId)) throw new Error(`invalid constraint evidence event id: ${eventId}`);
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

export function constraintEvidenceEventPath(abrainHome: string, eventId: string): string {
  const trimmed = abrainHome.replace(/[\\/]+$/g, "").replace(/\\/g, "/");
  if (!trimmed) throw new Error("abrainHome is required");
  return `${trimmed}/${constraintEvidenceEventRelativePath(eventId)}`;
}

export function constraintEvidenceEnvelopeContentHash(envelope: ConstraintEvidenceEnvelopeV1): string {
  return sha256Hex(constraintEvidenceEnvelopeJson(envelope));
}
