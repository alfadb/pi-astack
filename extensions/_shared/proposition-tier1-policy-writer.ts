/**
 * ADR0040 dedicated producer: Tier-1 natural correction constraint evidence
 * → normative policy proposition evidence.
 *
 * Envelope stays defined_inactive / write_enabled=false / fold=false.
 * Generic validateL1WritePreflight remains L1_SCHEMA_WRITE_DISABLED; only this
 * allowlisted producer may durable-append via the create-only path below.
 * No wall-clock fields enter the body (content-addressed idempotency).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import { isCanonicalMutationAuthorityError } from "./canonical-mutation-authority";
import { withCanonicalMutationBarrier } from "./canonical-mutation-barrier";
import {
  canonicalL1EnvelopeJson,
  defaultL1SchemaRegistryPath,
  expectedL1EventPath,
  expectedL1EventRelativePath,
  L1SchemaRegistryError,
  loadL1SchemaRegistry,
  validateL1Envelope,
  validateL1WritePreflight,
  type L1SchemaRoleRegistry,
} from "./l1-schema-registry";
import { sha256Hex } from "./jcs";
import {
  PROPOSITION_EVIDENCE_BODY_SCHEMA,
  PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  PROPOSITION_PRODUCTION_GENESIS_EVENT_ID,
  buildPropositionEnvelope,
  PropositionValidationError,
  validatePropositionEvidenceBody,
  type PropositionEvidenceBodyV1,
  type PropositionL1Envelope,
} from "./proposition";
import {
  CONSTRAINT_EVIDENCE_CANONICALIZATION,
  CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
  CONSTRAINT_EVIDENCE_HASH_ALG,
  type ConstraintEvidenceEnvelopeV1,
  type ConstraintEvidenceEventBodyV1,
  type ConstraintEvidenceScopeContext,
} from "../sediment/constraint-evidence/types";
import { constraintEvidenceBodyHash } from "../sediment/constraint-evidence/hash-envelope";

/** Minimal Tier-1 signal/draft shapes (mirror constraint integration; no reverse runtime import). */
export interface PropositionTier1SignalInput {
  user_quote?: string | null;
  correction_intent?: string | null;
  scope_description?: string | null;
  confidence?: number | null;
  provenance?: string | null;
  quote_source?: string | null;
  is_directive?: boolean | null;
}

export interface PropositionTier1DraftInput {
  title: string;
  body: string;
  entryConfidence: number;
  triggerPhrases?: string[];
  injectMode?: "always" | "listed";
}

export const PROPOSITION_TIER1_POLICY_PRODUCER = "pi-astack.proposition-tier1-policy-writer" as const;
export const PROPOSITION_TIER1_POLICY_PRODUCER_VERSION = "adr0040-tier1-policy-writer/v1" as const;

export type PropositionTier1PolicyWriteStatus = DurableCreateStatus;

/** Sole HOLD+retry checkpoint reason for raw storage I/O / unknown write failures. */
export const PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON =
  "proposition_tier1_policy_write_failed:write_failed" as const;

export interface PropositionTier1PolicyWriteResult {
  ok: boolean;
  status: PropositionTier1PolicyWriteStatus | "refused" | "write_failed";
  code?: string;
  eventId?: string;
  filePath?: string;
  envelope?: PropositionL1Envelope<PropositionEvidenceBodyV1>;
  generic_write_gate?: "L1_SCHEMA_WRITE_DISABLED";
  /** Low-sensitivity audit payload — never includes statement/body text. */
  audit: Readonly<{
    ok: boolean;
    status: string;
    code?: string;
    event_id?: string | null;
    constraint_event_id?: string | null;
    scope_level?: string | null;
    producer?: string;
  }>;
}

/**
 * Checkpoint reason for a failed tier1 policy write.
 * Raw I/O / unknown failures always map to the exact HOLD reason so
 * `isTerminalTier1Reject` does not advance past a transient storage fault.
 * Deterministic writer/validation refuses keep their specific code suffix.
 */
export function buildPropositionTier1PolicyWriteFailedCheckpointReason(
  result: Pick<PropositionTier1PolicyWriteResult, "status" | "code">,
): string {
  if (result.status === "write_failed") return PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON;
  return `proposition_tier1_policy_write_failed:${result.code ?? result.status}`;
}

/** True when a proposition_tier1_policy_write_failed:* reason is terminal (no HOLD+retry). */
export function isTerminalPropositionTier1PolicyWriteReason(reason: string): boolean {
  return reason.startsWith("proposition_tier1_policy_write_failed:")
    && reason !== PROPOSITION_TIER1_POLICY_WRITE_FAILED_HOLD_REASON;
}

export class PropositionTier1PolicyWriterError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionTier1PolicyWriterError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export interface AppendTier1PolicyPropositionOptions {
  abrainHome: string;
  registryPath?: string;
  /** Append-successful constraint envelope (create-only SOT for scope/quote). */
  constraintEnvelope: ConstraintEvidenceEnvelopeV1;
  constraintBody: ConstraintEvidenceEventBodyV1;
  signal: PropositionTier1SignalInput;
  draft: PropositionTier1DraftInput;
  sessionId: string;
  turnId: string;
}

export function buildTier1PolicyPropositionBody(options: {
  constraintEnvelope: ConstraintEvidenceEnvelopeV1;
  constraintBody: ConstraintEvidenceEventBodyV1;
  signal: PropositionTier1SignalInput;
  draft: PropositionTier1DraftInput;
  sessionId: string;
  turnId: string;
}): PropositionEvidenceBodyV1 {
  // Fail-closed causal binding: envelope is content-addressed SOT; caller cannot
  // supply a divergent body/session/turn/quote to forge lineage.
  const bound = assertConstraintCausalBinding(options);
  const constraintEventId = bound.constraintEventId;
  const constraintBody = bound.constraintBody;

  if (constraintBody.sanitizer.status === "blocked") {
    throw failure("PROPOSITION_TIER1_SANITIZER_BLOCKED", "constraint sanitizer blocked; refuse proposition");
  }

  const statement = resolveStatement(constraintBody);
  if (!statement) {
    throw failure("PROPOSITION_TIER1_STATEMENT_EMPTY", "no sanitized quote or durable constraint text for statement");
  }

  const quoteSha256 = sha256Hex(statement);
  const sanitizedQuote = typeof constraintBody.payload.sanitized_quote === "string"
    ? constraintBody.payload.sanitized_quote.trim()
    : "";
  // When statement is the selected sanitized quote, quote hash must match the
  // constraint source quote_hash (content-addressed witness).
  if (sanitizedQuote && statement === sanitizedQuote) {
    if (constraintBody.source.quote_hash !== quoteSha256) {
      throw failure(
        "PROPOSITION_TIER1_QUOTE_HASH_MISMATCH",
        "source.quote_hash must equal sha256 of selected sanitized quote",
      );
    }
  }

  const scope = resolveSpatialScope(constraintBody.scope);
  // Fail-closed: unknown/unresolved scope never becomes a policy proposition.
  if (scope.scope_level === "unknown") {
    throw failure("PROPOSITION_TIER1_SCOPE_UNKNOWN", "constraint scope is unknown/unresolved; refuse proposition");
  }
  if (scope.scope_level === "project" && !scope.project_id) {
    throw failure("PROPOSITION_TIER1_SCOPE_UNRESOLVED", "project scope missing project_id; refuse proposition");
  }

  const confidence = clampConfidence(
    constraintBody.intent.confidence
      ?? (typeof options.signal.confidence === "number" ? options.signal.confidence / 10 : undefined)
      ?? options.draft.entryConfidence / 10,
  );

  // Session/turn SOT is the constraint body (already validated against caller).
  const sessionId = constraintBody.session_id;
  const turnId = constraintBody.turn_id;

  const body = validatePropositionEvidenceBody({
    event_schema_version: PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: {
      name: PROPOSITION_TIER1_POLICY_PRODUCER,
      version: PROPOSITION_TIER1_POLICY_PRODUCER_VERSION,
    },
    epoch: {
      epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
      genesis_event_id: PROPOSITION_PRODUCTION_GENESIS_EVENT_ID,
    },
    proposition: {
      modality: "normative",
      statement,
      language: detectLanguage(statement),
    },
    facets: {
      provenance_authority: {
        source_kind: "user",
        authority_kind: "user_attested",
        source_event_id: constraintEventId,
        quote_sha256: quoteSha256,
      },
      spatial_scope: scope,
      temporal_horizon: {
        horizon: "durable",
        valid_from: null,
        valid_until: null,
      },
      trigger: {
        trigger_kind: "user_directive",
        // C6 (session_id, turn_id) from constraint body SOT only.
        trigger_ref: `session:${sessionId}/turn:${turnId}`,
      },
      maturity: {
        state: "accepted",
        review_state: "reviewed",
      },
      contestability: {
        status: "uncontested",
        counterevidence_event_ids: [],
      },
      confidence: {
        score: confidence,
        basis: "witnessed",
      },
      sensitivity: {
        classification: "public",
        handling: "none",
      },
      consumer_hints: {
        retrieval: true,
        policy: true,
        notes: [],
      },
      lineage: {
        causal_parents: [constraintEventId],
        derives_from: [constraintEventId],
        supersedes: [],
      },
    },
  });
  return body;
}

/**
 * Validate that the constraint envelope is content-addressed and that the
 * caller-supplied body/session/turn cannot diverge from it to forge lineage.
 */
export function assertConstraintCausalBinding(options: {
  constraintEnvelope: ConstraintEvidenceEnvelopeV1;
  constraintBody: ConstraintEvidenceEventBodyV1;
  sessionId: string;
  turnId: string;
}): {
  constraintEventId: string;
  constraintBody: ConstraintEvidenceEventBodyV1;
} {
  const envelope = options.constraintEnvelope;
  if (!envelope || typeof envelope !== "object") {
    throw failure("PROPOSITION_TIER1_ENVELOPE_INVALID", "constraint envelope is required");
  }
  if (envelope.schema !== CONSTRAINT_EVIDENCE_ENVELOPE_SCHEMA_VERSION) {
    throw failure("PROPOSITION_TIER1_ENVELOPE_SCHEMA", "constraint envelope schema unsupported");
  }
  if (envelope.canonicalization !== CONSTRAINT_EVIDENCE_CANONICALIZATION) {
    throw failure("PROPOSITION_TIER1_ENVELOPE_CANONICALIZATION", "constraint envelope canonicalization unsupported");
  }
  if (envelope.hash_alg !== CONSTRAINT_EVIDENCE_HASH_ALG) {
    throw failure("PROPOSITION_TIER1_ENVELOPE_HASH_ALG", "constraint envelope hash_alg unsupported");
  }
  const constraintEventId = envelope.event_id;
  if (!/^[0-9a-f]{64}$/.test(constraintEventId)) {
    throw failure("PROPOSITION_TIER1_CONSTRAINT_ID_INVALID", "constraint event_id must be sha256 hex");
  }
  if (typeof envelope.body_hash !== "string" || !/^[0-9a-f]{64}$/.test(envelope.body_hash)) {
    throw failure("PROPOSITION_TIER1_BODY_HASH_INVALID", "constraint body_hash must be sha256 hex");
  }
  if (envelope.event_id !== envelope.body_hash) {
    throw failure(
      "PROPOSITION_TIER1_ENVELOPE_NOT_CONTENT_ADDRESSED",
      "constraint event_id must equal body_hash",
    );
  }
  if (!envelope.body || typeof envelope.body !== "object") {
    throw failure("PROPOSITION_TIER1_ENVELOPE_BODY_MISSING", "constraint envelope.body is required");
  }
  if (!options.constraintBody || typeof options.constraintBody !== "object") {
    throw failure("PROPOSITION_TIER1_BODY_MISSING", "constraintBody is required");
  }

  // envelope.body is the content-addressed SOT; constraintBody must match exactly.
  const envelopeBodyHash = constraintEvidenceBodyHash(envelope.body);
  if (envelopeBodyHash !== envelope.body_hash) {
    throw failure(
      "PROPOSITION_TIER1_ENVELOPE_BODY_HASH_MISMATCH",
      "constraint envelope.body does not hash to body_hash",
    );
  }
  const providedBodyHash = constraintEvidenceBodyHash(options.constraintBody);
  if (providedBodyHash !== envelopeBodyHash) {
    throw failure(
      "PROPOSITION_TIER1_BODY_MISMATCH",
      "constraintBody must be identical to envelope.body (content-addressed)",
    );
  }

  // Session/turn: constraint body is SOT; caller values may not form a pseudo-lineage.
  if (options.constraintBody.session_id !== options.sessionId) {
    throw failure(
      "PROPOSITION_TIER1_SESSION_MISMATCH",
      "caller sessionId must equal constraint body session_id",
    );
  }
  if (options.constraintBody.turn_id !== options.turnId) {
    throw failure(
      "PROPOSITION_TIER1_TURN_MISMATCH",
      "caller turnId must equal constraint body turn_id",
    );
  }

  return { constraintEventId, constraintBody: options.constraintBody };
}

export function buildTier1PolicyPropositionEnvelope(options: AppendTier1PolicyPropositionOptions): PropositionL1Envelope<PropositionEvidenceBodyV1> {
  return buildPropositionEnvelope(
    PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
    buildTier1PolicyPropositionBody(options),
  );
}

export async function appendTier1PolicyProposition(
  options: AppendTier1PolicyPropositionOptions,
): Promise<PropositionTier1PolicyWriteResult> {
  const constraintEventId = options.constraintEnvelope.event_id ?? null;
  try {
    const abrainHome = path.resolve(options.abrainHome);
    await assertExistingAbrainHome(abrainHome);
    const registryPath = path.resolve(options.registryPath ?? defaultL1SchemaRegistryPath());
    const registry = loadL1SchemaRegistry(registryPath);
    assertDedicatedProducerRegistration(registry);

    const envelope = buildTier1PolicyPropositionEnvelope(options);
    const relativePath = expectedL1EventRelativePath(envelope.event_id);
    const targetPath = expectedL1EventPath(abrainHome, envelope.event_id);
    validateL1Envelope(envelope, {
      registry,
      abrainHome,
      filePath: targetPath,
      relativePath,
      expected: {
        envelopeSchema: PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
        domain: "proposition",
        role: "evidence",
        phase: "defined_inactive",
        producer: PROPOSITION_TIER1_POLICY_PRODUCER,
        eventType: "proposition_observed",
      },
    });

    const gate = await genericWriteGateCode(abrainHome, envelope, targetPath, registry);
    if (gate !== "L1_SCHEMA_WRITE_DISABLED") {
      throw failure("PROPOSITION_TIER1_GENERIC_GATE_DRIFT", "generic proposition write preflight must remain L1_SCHEMA_WRITE_DISABLED", { actual: gate });
    }

    const canonical = canonicalL1EnvelopeJson(envelope);
    // Generic gate stays outside; tracked L1 parent+create are barrier-owned so
    // store-present foreground closes before mkdir and concurrent creates serialize.
    // `.state` pending/audit markers remain outside this semantic boundary.
    const status = await withCanonicalMutationBarrier(abrainHome, async () => {
      await createTargetParentNoSymlink(abrainHome, targetPath);
      return durableAtomicCreateFile(targetPath, canonical, { mode: 0o600 });
    });
    if (status === "collision") {
      throw failure("PROPOSITION_TIER1_COLLISION", "proposition target exists with different bytes", { eventId: envelope.event_id });
    }
    return {
      ok: true,
      status,
      eventId: envelope.event_id,
      filePath: targetPath,
      envelope,
      generic_write_gate: gate,
      audit: {
        ok: true,
        status,
        event_id: envelope.event_id,
        constraint_event_id: constraintEventId,
        scope_level: envelope.body.facets.spatial_scope.scope_level,
        producer: PROPOSITION_TIER1_POLICY_PRODUCER,
      },
    };
  } catch (err) {
    // Authority fence must bubble for worker-rpc → local_executor_authority_revoked
    // and must never be classified as a terminal refused write that advances queue/CP.
    if (isCanonicalMutationAuthorityError(err)) throw err;
    const classified = classifyTier1PolicyWriteFailure(err);
    return {
      ok: false,
      status: classified.status,
      code: classified.code,
      audit: {
        ok: false,
        status: classified.status,
        // Low-sens diagnostics retain the original writer/Node code (incl. EACCES/ENOSPC).
        code: classified.code,
        event_id: null,
        constraint_event_id: constraintEventId,
        producer: PROPOSITION_TIER1_POLICY_PRODUCER,
      },
    };
  }
}

function resolveStatement(body: ConstraintEvidenceEventBodyV1): string {
  const quote = typeof body.payload.sanitized_quote === "string" ? body.payload.sanitized_quote.trim() : "";
  if (quote) return quote;
  const durable = typeof body.payload.candidate_constraint_text === "string"
    ? body.payload.candidate_constraint_text.trim()
    : "";
  return durable;
}

function resolveSpatialScope(scope: ConstraintEvidenceScopeContext): {
  scope_level: "global" | "project" | "unknown";
  project_id: string | null;
  domain: null;
} {
  const hint = scope.scope_hint;
  if (hint.kind === "global") {
    return { scope_level: "global", project_id: null, domain: null };
  }
  if (hint.kind === "project") {
    const projectId = typeof hint.project_id === "string" && hint.project_id.trim()
      ? hint.project_id.trim()
      : (typeof scope.active_project_binding.project_id === "string" && scope.active_project_binding.project_id.trim()
        ? scope.active_project_binding.project_id.trim()
        : null);
    if (!projectId) return { scope_level: "unknown", project_id: null, domain: null };
    return { scope_level: "project", project_id: projectId, domain: null };
  }
  return { scope_level: "unknown", project_id: null, domain: null };
}

function detectLanguage(statement: string): string {
  return /[\u4e00-\u9fff]/.test(statement) ? "zh" : "en";
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function assertDedicatedProducerRegistration(registry: L1SchemaRoleRegistry): void {
  const entry = registry.entries.find((candidate) => candidate.envelope_schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA);
  if (!entry
    || entry.phase !== "defined_inactive"
    || entry.write_enabled
    || entry.fold_eligible
    || !entry.producers?.includes(PROPOSITION_TIER1_POLICY_PRODUCER)
    || !entry.event_types?.includes("proposition_observed")) {
    throw failure(
      "PROPOSITION_TIER1_REGISTRY_DRIFT",
      "dedicated tier1 policy producer must be allowlisted on the unchanged inactive evidence entry",
    );
  }
}

async function genericWriteGateCode(
  abrainHome: string,
  envelope: PropositionL1Envelope<PropositionEvidenceBodyV1>,
  targetPath: string,
  registry: L1SchemaRoleRegistry,
): Promise<string> {
  try {
    await validateL1WritePreflight({
      abrainHome,
      envelope,
      targetPath,
      registry,
      expected: {
        envelopeSchema: PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
        domain: "proposition",
        role: "evidence",
        producer: PROPOSITION_TIER1_POLICY_PRODUCER,
        eventType: "proposition_observed",
      },
    });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return errorCode(err);
  }
}

async function assertExistingAbrainHome(abrainHome: string): Promise<void> {
  const stat = await fs.lstat(abrainHome).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) throw failure("PROPOSITION_TIER1_ABRAIN_MISSING", "abrain home must already exist", { abrainHome });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw failure("PROPOSITION_TIER1_PATH_UNSAFE", "abrain home must be a non-symlink directory", { abrainHome });
  }
}

async function createTargetParentNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  const parent = path.dirname(targetPath);
  const relative = path.relative(abrainHome, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw failure("PROPOSITION_TIER1_PATH_ESCAPE", "target parent escapes abrain home");
  }
  let current = abrainHome;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const existing = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!existing) {
      await fs.mkdir(current, { mode: 0o700 }).catch((err: unknown) => {
        if (!isNodeError(err) || err.code !== "EEXIST") throw err;
      });
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw failure("PROPOSITION_TIER1_PATH_UNSAFE", "target directory chain contains a symlink or non-directory", { path: current });
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return String((err as { code: string }).code);
  }
  return "PROPOSITION_TIER1_WRITE_FAILED";
}

/**
 * Deterministic PropositionTier1PolicyWriterError / validation refuses stay
 * `refused` (terminal at the checkpoint). Collision is content-addressed
 * integrity failure — terminal, never infinite HOLD.
 * L1SchemaRegistryError (validateL1Envelope / load registry) and
 * PropositionValidationError (validatePropositionEvidenceBody) are also
 * deterministic validation refuses — not transient storage faults.
 * Raw Node I/O (ENOSPC/EIO/EMFILE/EACCES/…) and unknown throws are
 * `write_failed` so the checkpoint HOLDs and retries.
 */
function classifyTier1PolicyWriteFailure(err: unknown): {
  status: "refused" | "write_failed";
  code: string;
} {
  if (err instanceof PropositionTier1PolicyWriterError) {
    // Explicit WRITE_FAILED codes (if ever thrown as domain errors) stay transient.
    if (err.code === "PROPOSITION_TIER1_WRITE_FAILED" || err.code.endsWith("_WRITE_FAILED")) {
      return { status: "write_failed", code: err.code };
    }
    // Includes PROPOSITION_TIER1_COLLISION and all validation/scope/registry refuses.
    return { status: "refused", code: err.code };
  }
  // Cross-module validation errors carry `.code` and would otherwise match the
  // broad Node errno check below; classify them as terminal refused first.
  if (err instanceof L1SchemaRegistryError || err instanceof PropositionValidationError) {
    return { status: "refused", code: err.code };
  }
  if (isNodeError(err) && typeof err.code === "string" && err.code.length > 0) {
    return { status: "write_failed", code: err.code };
  }
  return { status: "write_failed", code: errorCode(err) };
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionTier1PolicyWriterError {
  return new PropositionTier1PolicyWriterError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
