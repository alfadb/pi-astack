import { canonicalL1BodyHash, canonicalL1EnvelopeJson } from "./l1-schema-registry";
import { canonicalizeJcs, sha256Hex } from "./jcs";
import type { PropositionEvidenceBodyV1, PropositionL1Envelope } from "./proposition";

export const REAL_POLICY_APPEND_EVENT_ID = "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6" as const;
export const REAL_POLICY_APPEND_RELATIVE_TARGET = `l1/events/sha256/1c/8c/${REAL_POLICY_APPEND_EVENT_ID}.json` as const;
export const REAL_POLICY_APPEND_ABSOLUTE_TARGET = `/home/worker/.abrain/${REAL_POLICY_APPEND_RELATIVE_TARGET}` as const;
export const REAL_POLICY_APPEND_FIRST_SHARD = "/home/worker/.abrain/l1/events/sha256/1c" as const;
export const REAL_POLICY_APPEND_SECOND_SHARD = "/home/worker/.abrain/l1/events/sha256/1c/8c" as const;
export const REAL_POLICY_APPEND_STATEMENT = "New feature and capability acceptance MUST use real production data; synthetic data, handwritten fixtures, and waiting for low-frequency natural events are insufficient as sole acceptance evidence. When compliance, privacy, or security prevents direct production access, equivalent evidence must be explicitly documented and human-approved." as const;
export const REAL_POLICY_APPEND_STATEMENT_SHA256 = "6a25beb3a45141409c139b9832068f3b23b98cd21134cfed07f34c4feeffc262" as const;
export const REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256 = "0fe6ded4012423cbebcf618341d68a57a459dd010e2fa56f6ced0a1a311eeb2e" as const;
export const REAL_POLICY_APPEND_CANONICAL_BYTES = 1868 as const;
export const REAL_POLICY_APPEND_TUPLE_SCHEMA = "adr0040-real-policy-proposition-append-fixed-tuple/v1" as const;

export interface RealPolicyAppendFixedTuple {
  tuple_schema_version: typeof REAL_POLICY_APPEND_TUPLE_SCHEMA;
  event_id: typeof REAL_POLICY_APPEND_EVENT_ID;
  body_hash: typeof REAL_POLICY_APPEND_EVENT_ID;
  relative_target_path: typeof REAL_POLICY_APPEND_RELATIVE_TARGET;
  absolute_target_path: typeof REAL_POLICY_APPEND_ABSOLUTE_TARGET;
  first_level_shard: typeof REAL_POLICY_APPEND_FIRST_SHARD;
  second_level_shard: typeof REAL_POLICY_APPEND_SECOND_SHARD;
  envelope: PropositionL1Envelope<PropositionEvidenceBodyV1>;
  canonical_envelope_json: string;
  canonical_envelope_raw_sha256: typeof REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256;
  canonical_envelope_utf8_bytes_including_lf: typeof REAL_POLICY_APPEND_CANONICAL_BYTES;
  caller_supplied_tuple_fields: readonly never[];
}

export class RealPolicyAppendWriterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RealPolicyAppendWriterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

/** This no-argument constructor is the only tuple source. Callers cannot supply tuple fields. */
export function fixedRealPolicyAppendTuple(): RealPolicyAppendFixedTuple {
  const body: PropositionEvidenceBodyV1 = {
    event_schema_version: "proposition-evidence-event/v1",
    event_type: "proposition_observed",
    producer: {
      name: "pi-astack.proposition-production-evidence-writer",
      version: "adr0040-real-policy-proposition-append-writer/v1",
    },
    epoch: {
      epoch_id: "adr0040-production-genesis-v1",
      genesis_event_id: "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
    },
    proposition: { language: "en", modality: "normative", statement: REAL_POLICY_APPEND_STATEMENT },
    facets: {
      confidence: { basis: "witnessed", score: 1 },
      consumer_hints: { notes: [], policy: true, retrieval: true },
      contestability: { counterevidence_event_ids: [], status: "uncontested" },
      lineage: { causal_parents: [], derives_from: [], supersedes: [] },
      maturity: { review_state: "reviewed", state: "accepted" },
      provenance_authority: {
        authority_kind: "user_attested",
        quote_sha256: REAL_POLICY_APPEND_STATEMENT_SHA256,
        source_event_id: null,
        source_kind: "user",
      },
      sensitivity: { classification: "public", handling: "none" },
      spatial_scope: { domain: null, project_id: null, scope_level: "global" },
      temporal_horizon: { horizon: "durable", valid_from: null, valid_until: null },
      trigger: {
        trigger_kind: "user_directive",
        trigger_ref: "session:019f569c-40d3-73f0-9a5f-666b395f6b9a/message:f2774365",
      },
    },
  };
  const bodyHash = canonicalL1BodyHash(body);
  if (bodyHash !== REAL_POLICY_APPEND_EVENT_ID) fail("REAL_POLICY_APPEND_BODY_HASH_DRIFT", "fixed body no longer hashes to the frozen event ID", { bodyHash });
  const envelope: PropositionL1Envelope<PropositionEvidenceBodyV1> = {
    schema: "proposition-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: REAL_POLICY_APPEND_EVENT_ID,
    body_hash: REAL_POLICY_APPEND_EVENT_ID,
    body,
  };
  const raw = canonicalL1EnvelopeJson(envelope);
  const rawHash = sha256Hex(raw);
  if (rawHash !== REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256 || Buffer.byteLength(raw) !== REAL_POLICY_APPEND_CANONICAL_BYTES) {
    fail("REAL_POLICY_APPEND_ENVELOPE_DRIFT", "fixed envelope bytes differ from the frozen tuple", { rawHash, bytes: Buffer.byteLength(raw) });
  }
  if (sha256Hex(REAL_POLICY_APPEND_STATEMENT) !== REAL_POLICY_APPEND_STATEMENT_SHA256) fail("REAL_POLICY_APPEND_STATEMENT_DRIFT", "fixed statement hash differs");
  return deepFreeze({
    tuple_schema_version: REAL_POLICY_APPEND_TUPLE_SCHEMA,
    event_id: REAL_POLICY_APPEND_EVENT_ID,
    body_hash: REAL_POLICY_APPEND_EVENT_ID,
    relative_target_path: REAL_POLICY_APPEND_RELATIVE_TARGET,
    absolute_target_path: REAL_POLICY_APPEND_ABSOLUTE_TARGET,
    first_level_shard: REAL_POLICY_APPEND_FIRST_SHARD,
    second_level_shard: REAL_POLICY_APPEND_SECOND_SHARD,
    envelope,
    canonical_envelope_json: raw,
    canonical_envelope_raw_sha256: REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256,
    canonical_envelope_utf8_bytes_including_lf: REAL_POLICY_APPEND_CANONICAL_BYTES,
    caller_supplied_tuple_fields: Object.freeze([] as never[]),
  });
}

export function assertExactRealPolicyAppendEnvelope(input: unknown): void {
  const expected = fixedRealPolicyAppendTuple().envelope;
  if (canonicalizeJcs(input) !== canonicalizeJcs(expected)) fail("REAL_POLICY_APPEND_TUPLE_REFUSED", "only the private frozen event envelope is accepted");
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new RealPolicyAppendWriterError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
