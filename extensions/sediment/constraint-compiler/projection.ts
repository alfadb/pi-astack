import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_CONSTRAINT_L2 } from "../../_shared/canonical-l2-contract";
import { validateL1WritePreflight } from "../../_shared/l1-schema-registry";
import { canonicalJson, canonicalJsonValue } from "../constraint-evidence/canonical-json";
import { constraintEvidenceEventPath, sha256Hex } from "../constraint-evidence/hash-envelope";
import { guardConstraintEvidencePath, isPathInside } from "../constraint-evidence/append";
import { renderConstraintL2View, type RenderedConstraintL2View } from "./render";
import { stableCanonicalize } from "./normalize";
import type { ValidatedConstraintCompilerDecision } from "./types";

// ADR0039 Constraint L2 (4×T0 unanimous 2026-06-20, NS-2 + FIX-1).
// The constraint compiler's LLM output (the validated decision) is a PROJECTION,
// not witnessed evidence. §4.3 requires LLM output to be 固化 as a new immutable
// L1 event BEFORE it becomes L2 bytes. This module 固化s the validated decision
// as a content-addressed L1 *projection* event under a DISTINCT envelope schema
// (constraint-projection-envelope/v1), so the constraint event-scan (which only
// ingests constraint-evidence-envelope/v1) never re-ingests it as an input
// signal (NS-2 feedback-loop guard, enforced by event-scan's foreign-skip).
export const CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION = "constraint-projection-envelope/v1";
export const CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION = "constraint-projection-event/v1";
export const CONSTRAINT_PROJECTION_CANONICALIZATION = "RFC8785-JCS";
export const CONSTRAINT_PROJECTION_HASH_ALG = "sha256";
// Must equal TEMPLATE_VERSION in render.ts (the renderer that produces L2 bytes).
export const CONSTRAINT_L2_RENDER_TEMPLATE_VERSION = CURRENT_CONSTRAINT_L2.templateVersion;

export interface ConstraintProjectionProvenance {
  model: string;
  prompt_hash: string;
  input_hash: string;
  raw_output_hash: string;
  parsed_output_hash?: string;
  acceptance: "accepted_for_event_append";
}

export interface ConstraintProjectionEventBodyV1 {
  event_schema_version: typeof CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION;
  event_type: "constraint_compiled_view_produced";
  created_at_utc: string;
  device_id: string;
  producer_nonce: string;
  causal_parents: string[];
  producer: { name: "sediment.constraint-compiler"; version: string };
  template_version: string;
  input_root_hash: string;
  input_event_ids: string[];
  provenance: ConstraintProjectionProvenance;
  validated_decision: Record<string, unknown>;
}

export interface ConstraintProjectionEnvelopeV1 {
  schema: typeof CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION;
  canonicalization: typeof CONSTRAINT_PROJECTION_CANONICALIZATION;
  hash_alg: typeof CONSTRAINT_PROJECTION_HASH_ALG;
  event_id: string;
  body_hash: string;
  body: ConstraintProjectionEventBodyV1;
}

export function constraintProjectionBodyHash(body: ConstraintProjectionEventBodyV1): string {
  return sha256Hex(canonicalJson(canonicalJsonValue(body)));
}

export function createConstraintProjectionEnvelope(body: ConstraintProjectionEventBodyV1): ConstraintProjectionEnvelopeV1 {
  const bodyHash = constraintProjectionBodyHash(body);
  return {
    schema: CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION,
    canonicalization: CONSTRAINT_PROJECTION_CANONICALIZATION,
    hash_alg: CONSTRAINT_PROJECTION_HASH_ALG,
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

export function constraintProjectionEnvelopeJson(envelope: ConstraintProjectionEnvelopeV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

// JSON round-trip drops `undefined` so the 固化 body is canonicalizable (the JCS
// canonicalizer rejects undefined) AND the stored decision is byte-stable: the
// exact object reconcile re-renders from. render(originalDecision) ===
// render(roundTripped) because the renderer reads named fields and treats
// missing === undefined identically.
export function normalizeDecisionForProjection(decision: ValidatedConstraintCompilerDecision): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decision)) as Record<string, unknown>;
}

export function constraintL2RelativePath(): string {
  return CURRENT_CONSTRAINT_L2.canonicalPath;
}

export type ConstraintProjectionAppendStatus =
  | "appended"
  | "idempotent_duplicate"
  | "collision"
  | "path_violation"
  | "write_failed";

export interface AppendConstraintProjectionResult {
  ok: boolean;
  status: ConstraintProjectionAppendStatus;
  eventId: string;
  filePath: string;
}

async function writeFileAtomic(target: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function appendConstraintProjectionEvent(abrainHome: string, body: ConstraintProjectionEventBodyV1): Promise<AppendConstraintProjectionResult> {
  const envelope = createConstraintProjectionEnvelope(body);
  const eventId = envelope.event_id;
  const filePath = path.resolve(constraintEvidenceEventPath(abrainHome, eventId));
  // l1/events-only path guard (rejects canonical rules/knowledge/projects roots).
  const guard = guardConstraintEvidencePath({ abrainHome, targetPath: filePath });
  if (!guard.ok) return { ok: false, status: "path_violation", eventId, filePath };
  // Canonical-path R3.4.2 P1-S3 write gate: central registry role/producer
  // check plus lstat+realpath symlink-escape validation before durable write.
  try {
    await validateL1WritePreflight({
      abrainHome,
      envelope,
      targetPath: filePath,
      expected: { domain: "constraint", role: "canonical" },
    });
  } catch {
    return { ok: false, status: "path_violation", eventId, filePath };
  }
  const content = constraintProjectionEnvelopeJson(envelope);
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    return existing === content
      ? { ok: true, status: "idempotent_duplicate", eventId, filePath }
      : { ok: false, status: "collision", eventId, filePath };
  } catch (err) {
    if (!(err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      return { ok: false, status: "write_failed", eventId, filePath };
    }
  }
  const wrote = await writeFileAtomic(filePath, content);
  return wrote ? { ok: true, status: "appended", eventId, filePath } : { ok: false, status: "write_failed", eventId, filePath };
}

// ADR0039 Constraint L2 (4×T0 v3 bundle-a, deepseek comparator): among a set of
// constraint projection events, the chronologically-latest is created_at_utc
// DESC, tiebreak event_id DESC. There is no DAG edge between projection events
// (causal_parents point to constraint-evidence INPUT events, not prior
// projections), and the compiler is single-writer (one device) so wall-clock is
// self-consistent; the event_id (content hash) tiebreak guarantees determinism
// under timestamp collision. Used by the reconcile stale-L2 scan: if the L2's
// referenced event is not the latest, a newer 固化 event was orphaned (e.g. a
// swallowed l2_write_failed) and the L2 is stale.
export function selectLatestConstraintProjectionEventId(
  events: ReadonlyArray<{ eventId: string; createdAtUtc: string }>,
): string | null {
  if (!events.length) return null;
  return [...events].sort((a, b) =>
    b.createdAtUtc.localeCompare(a.createdAtUtc) || b.eventId.localeCompare(a.eventId),
  )[0].eventId;
}

export interface FixateConstraintL2Options {
  abrainHome: string;
  decision: ValidatedConstraintCompilerDecision;
  provenance: ConstraintProjectionProvenance;
  inputEventIds: string[];
  createdAtUtc: string;
  deviceId: string;
  producerVersion: string;
}

export type FixateConstraintL2Status = "written" | "unchanged" | "append_failed" | "l2_write_failed" | "l2_path_violation";

export interface FixateConstraintL2Result {
  ok: boolean;
  status: FixateConstraintL2Status;
  eventId?: string;
  l2RelativePath: string;
  decisionHash: string;
  append?: AppendConstraintProjectionResult;
  view?: RenderedConstraintL2View;
}

// 固化 the validated decision as an immutable L1 projection event, then render the
// deterministic L2 view from it (append-before-render). Idempotency gate: if the
// committed L2 already carries this decision's decision_hash, skip entirely (no
// new 固化 event, no rewrite) so unchanged compiler re-runs cause zero churn /
// no spurious dirty-derived-view on pre-push.
export async function fixateConstraintDecisionAndRenderL2(options: FixateConstraintL2Options): Promise<FixateConstraintL2Result> {
  const normalizedDecision = normalizeDecisionForProjection(options.decision);
  const typedNormalized = normalizedDecision as unknown as ValidatedConstraintCompilerDecision;
  const decisionHash = sha256Hex(stableCanonicalize(typedNormalized));
  const l2RelativePath = constraintL2RelativePath();
  const l2Path = path.resolve(options.abrainHome, l2RelativePath);
  const l2Root = path.resolve(options.abrainHome, "l2", "views", "constraint");
  if (!isPathInside(l2Root, l2Path)) return { ok: false, status: "l2_path_violation", l2RelativePath, decisionHash };

  const existingL2 = await fs.readFile(l2Path, "utf-8").catch(() => null);
  if (existingL2 && existingL2.includes(`decision_hash: ${decisionHash}\n`)) {
    return { ok: true, status: "unchanged", l2RelativePath, decisionHash };
  }

  const body: ConstraintProjectionEventBodyV1 = {
    event_schema_version: CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION,
    event_type: "constraint_compiled_view_produced",
    created_at_utc: options.createdAtUtc,
    device_id: options.deviceId,
    producer_nonce: options.decision.inputRootHash,
    causal_parents: [...options.inputEventIds].sort(),
    producer: { name: "sediment.constraint-compiler", version: options.producerVersion },
    template_version: CONSTRAINT_L2_RENDER_TEMPLATE_VERSION,
    input_root_hash: options.decision.inputRootHash,
    input_event_ids: [...options.inputEventIds].sort(),
    provenance: options.provenance,
    validated_decision: normalizedDecision,
  };
  const append = await appendConstraintProjectionEvent(options.abrainHome, body);
  if (!append.ok) return { ok: false, status: "append_failed", eventId: append.eventId, l2RelativePath, decisionHash, append };

  const view = renderConstraintL2View(typedNormalized, append.eventId);
  const wrote = await writeFileAtomic(l2Path, view.markdown);
  if (!wrote) return { ok: false, status: "l2_write_failed", eventId: append.eventId, l2RelativePath, decisionHash, append, view };
  return { ok: true, status: "written", eventId: append.eventId, l2RelativePath, decisionHash, append, view };
}
