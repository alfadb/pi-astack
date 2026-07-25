/**
 * Durable held Tier-1 authorized classifier decisions.
 *
 * When the LLM classifier has already authorized a Tier-1 directive
 * (user-expressed ∧ durable ∧ rule_scope ∧ is_directive/conf≥8) but the
 * deterministic capture path (constraint evidence / proposition bridge)
 * fails transiently (canonical RECOVERY_QUARANTINED, startup barrier,
 * write_failed, …), the already-authorized decision must survive:
 *
 *   - process restart
 *   - transcript re-classification demotion (assistant echo → multi-match
 *     → content-in-transcript)
 *
 * Held means durable retry of the EXACT authorized decision with original
 * provenance / rule_scope / directive / evidence lineage — never re-guess
 * from the later transcript. Success acks the held record; failure never
 * consumes or degrades. CE/proposition remain content-addressed exactly-once.
 *
 * Path: ~/.abrain/.state/sediment/tier1-held/{pending,acked}/<decisionId>.json
 * Shape mirrors durable intake / publication-outbox (create-only, content-id).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile, fsyncDirectory } from "../_shared/durable-write";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined } from "../_shared/jcs";
import { isTier1Directive, type CorrectionSignal } from "./correction-pipeline";

export const TIER1_HELD_DECISION_SCHEMA = "sediment-tier1-held-decision/v1" as const;

/** Frozen authorized classifier decision (no re-derive of provenance/scope). */
export interface Tier1HeldSignal {
  signal_found: true;
  typing: "durable";
  provenance: "user-expressed";
  quote_source?: CorrectionSignal["quote_source"];
  is_directive?: boolean;
  rule_scope: "project" | "global";
  confidence?: number;
  user_quote?: string;
  surrounding_context?: string;
  correction_intent?: string;
  scope_description?: string;
  most_likely_error?: string;
  target_entry_slug?: string | null;
  resolution_hypothesis?: string | null;
  quote_multi_match?: boolean;
  quote_matched_roles?: Array<"user" | "transcript" | "assistant">;
}

export interface Tier1HeldAuthorizedDecision {
  schema: typeof TIER1_HELD_DECISION_SCHEMA;
  decisionId: string;
  sessionId: string;
  projectId: string;
  projectRoot?: string;
  sourceTurnId: string;
  /** Source-window timestamp when the classifier authorized (not wall-clock identity). */
  authorizedAtUtc: string;
  holdReason: string;
  candidateId: string;
  signal: Tier1HeldSignal;
}

export type Tier1HeldWriteStatus = "created" | "identical" | "collision";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

export function tier1HeldRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "tier1-held");
}

export function tier1HeldPendingDir(abrainHome: string): string {
  return path.join(tier1HeldRoot(abrainHome), "pending");
}

export function tier1HeldAckedDir(abrainHome: string): string {
  return path.join(tier1HeldRoot(abrainHome), "acked");
}

function assertDecisionId(decisionId: string): void {
  if (!/^[0-9a-f]{64}$/.test(decisionId)) {
    throw new Error(`invalid tier1 held decisionId: ${decisionId}`);
  }
}

export function tier1HeldPendingPath(abrainHome: string, decisionId: string): string {
  assertDecisionId(decisionId);
  return path.join(tier1HeldPendingDir(abrainHome), `${decisionId}.json`);
}

function quoteKey(signal: Pick<Tier1HeldSignal, "user_quote" | "scope_description" | "correction_intent">): string {
  const quote = (signal.user_quote ?? "").trim();
  if (quote) return sha256Hex(quote);
  const fallback = `${(signal.scope_description ?? "").trim()}\n${(signal.correction_intent ?? "").trim()}`;
  return sha256Hex(fallback || "empty-tier1-signal");
}

/** Identity only — no wall clock / random / holdReason. Same authorization → same id. */
export function computeTier1HeldDecisionId(input: {
  sessionId: string;
  projectId: string;
  candidateId: string;
  signal: Pick<Tier1HeldSignal, "user_quote" | "scope_description" | "correction_intent" | "rule_scope">;
}): string {
  return sha256Hex(canonicalizeJcs(normalizeJcsValueOmittingUndefined({
    schema: TIER1_HELD_DECISION_SCHEMA,
    sessionId: input.sessionId,
    projectId: input.projectId,
    candidateId: input.candidateId,
    rule_scope: input.signal.rule_scope,
    quote_key: quoteKey(input.signal),
  })));
}

/**
 * Freeze an already-authorized CorrectionSignal for durable retry.
 * Reuses isTier1Directive fail-closed (no parallel regex / ad-hoc predicate).
 */
export function freezeTier1HeldSignal(signal: CorrectionSignal): Tier1HeldSignal {
  // Single Tier-1 authority: same gate as live direct path / shouldEscalateToCurator.
  if (!isTier1Directive(signal)) {
    throw new Error("tier1 held decision requires already-authorized Tier-1 directive (isTier1Directive fail-closed)");
  }
  // isTier1Directive already requires signal_found durable user-expressed + rule_scope;
  // restate the enum narrow so the frozen type is project|global (not optional).
  const ruleScope = signal.rule_scope;
  if (ruleScope !== "project" && ruleScope !== "global") {
    throw new Error("tier1 held decision requires classifier rule_scope project|global");
  }
  return {
    signal_found: true,
    typing: "durable",
    provenance: "user-expressed",
    ...(signal.quote_source ? { quote_source: signal.quote_source } : { quote_source: "user_message" }),
    ...(typeof signal.is_directive === "boolean" ? { is_directive: signal.is_directive } : {}),
    rule_scope: ruleScope,
    ...(typeof signal.confidence === "number" ? { confidence: signal.confidence } : {}),
    ...(signal.user_quote !== undefined ? { user_quote: signal.user_quote } : {}),
    ...(signal.surrounding_context !== undefined ? { surrounding_context: signal.surrounding_context } : {}),
    ...(signal.correction_intent !== undefined ? { correction_intent: signal.correction_intent } : {}),
    ...(signal.scope_description !== undefined ? { scope_description: signal.scope_description } : {}),
    ...(signal.most_likely_error !== undefined ? { most_likely_error: signal.most_likely_error } : {}),
    ...(signal.target_entry_slug !== undefined ? { target_entry_slug: signal.target_entry_slug } : {}),
    ...(signal.resolution_hypothesis !== undefined ? { resolution_hypothesis: signal.resolution_hypothesis } : {}),
    ...(typeof signal.quote_multi_match === "boolean" ? { quote_multi_match: signal.quote_multi_match } : {}),
    ...(signal.quote_matched_roles ? { quote_matched_roles: [...signal.quote_matched_roles] } : {}),
  };
}

export function buildTier1HeldAuthorizedDecision(input: {
  sessionId: string;
  projectId: string;
  projectRoot?: string;
  sourceTurnId: string;
  authorizedAtUtc: string;
  holdReason: string;
  candidateId: string;
  signal: CorrectionSignal;
}): Tier1HeldAuthorizedDecision {
  const frozen = freezeTier1HeldSignal(input.signal);
  const decisionId = computeTier1HeldDecisionId({
    sessionId: input.sessionId,
    projectId: input.projectId,
    candidateId: input.candidateId,
    signal: frozen,
  });
  return {
    schema: TIER1_HELD_DECISION_SCHEMA,
    decisionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    ...(input.projectRoot ? { projectRoot: path.resolve(input.projectRoot) } : {}),
    sourceTurnId: input.sourceTurnId,
    authorizedAtUtc: input.authorizedAtUtc,
    holdReason: input.holdReason.slice(0, 500),
    candidateId: input.candidateId,
    signal: frozen,
  };
}

function validateHeld(record: Tier1HeldAuthorizedDecision, expectedId?: string): void {
  if (!record || record.schema !== TIER1_HELD_DECISION_SCHEMA) {
    throw new Error("unsupported tier1 held decision schema");
  }
  if (expectedId && record.decisionId !== expectedId) {
    throw new Error("tier1 held decision filename/decisionId mismatch");
  }
  const expected = computeTier1HeldDecisionId(record);
  if (record.decisionId !== expected) {
    throw new Error(`tier1 held decisionId mismatch: ${record.decisionId} !== ${expected}`);
  }
  if (record.signal.provenance !== "user-expressed") {
    throw new Error("tier1 held decision corrupted: provenance must stay user-expressed");
  }
  if (record.signal.rule_scope !== "project" && record.signal.rule_scope !== "global") {
    throw new Error("tier1 held decision corrupted: rule_scope must stay project|global");
  }
}

export async function holdTier1AuthorizedDecision(
  abrainHome: string,
  input: {
    sessionId: string;
    projectId: string;
    projectRoot?: string;
    sourceTurnId: string;
    authorizedAtUtc: string;
    holdReason: string;
    candidateId: string;
    signal: CorrectionSignal;
  },
): Promise<{ status: Tier1HeldWriteStatus; decision: Tier1HeldAuthorizedDecision; filePath: string }> {
  const decision = buildTier1HeldAuthorizedDecision(input);
  validateHeld(decision);
  const pendingDir = tier1HeldPendingDir(abrainHome);
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o700 });
  const filePath = tier1HeldPendingPath(abrainHome, decision.decisionId);
  // holdReason may change across retries; identity is decisionId. First writer wins
  // for the frozen signal; later holds with same identity are identical/collision.
  const raw = `${JSON.stringify(decision)}\n`;
  const createStatus = await durableAtomicCreateFile(filePath, raw, { mode: 0o600, verifyCreated: false });
  if (createStatus !== "collision") {
    return { status: createStatus, decision, filePath };
  }
  try {
    const existing = JSON.parse(await fs.readFile(filePath, "utf-8")) as Tier1HeldAuthorizedDecision;
    validateHeld(existing, decision.decisionId);
    // Same identity: keep existing frozen signal (original provenance lineage).
    // Refresh holdReason via atomic rewrite only when signal identity matches.
    if (
      existing.signal.provenance === decision.signal.provenance
      && existing.signal.rule_scope === decision.signal.rule_scope
      && quoteKey(existing.signal) === quoteKey(decision.signal)
    ) {
      const refreshed: Tier1HeldAuthorizedDecision = {
        ...existing,
        holdReason: decision.holdReason,
      };
      await durableAtomicWriteFile(filePath, `${JSON.stringify(refreshed)}\n`, { mode: 0o600 });
      return { status: "identical", decision: refreshed, filePath };
    }
  } catch {
    // hard collision below
  }
  return { status: "collision", decision, filePath };
}

export async function readTier1HeldDecision(
  abrainHome: string,
  decisionId: string,
): Promise<Tier1HeldAuthorizedDecision | null> {
  const filePath = tier1HeldPendingPath(abrainHome, decisionId);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as Tier1HeldAuthorizedDecision;
    validateHeld(parsed, decisionId);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listTier1HeldDecisions(abrainHome: string): Promise<Tier1HeldAuthorizedDecision[]> {
  const pendingDir = tier1HeldPendingDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(pendingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Tier1HeldAuthorizedDecision[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(pendingDir, name), "utf-8")) as Tier1HeldAuthorizedDecision;
      validateHeld(parsed, name.slice(0, 64));
      out.push(parsed);
    } catch {
      // corrupt remains on disk for inspection; never silent-ack
    }
  }
  out.sort((a, b) =>
    a.authorizedAtUtc.localeCompare(b.authorizedAtUtc)
    || a.decisionId.localeCompare(b.decisionId));
  return out;
}

export async function listTier1HeldDecisionsForSession(
  abrainHome: string,
  sessionId: string,
): Promise<Tier1HeldAuthorizedDecision[]> {
  return (await listTier1HeldDecisions(abrainHome)).filter((d) => d.sessionId === sessionId);
}

/** Oldest pending held decision for a session (FIFO durable retry). */
export async function peekOldestTier1HeldDecision(
  abrainHome: string,
  sessionId: string,
): Promise<Tier1HeldAuthorizedDecision | null> {
  const list = await listTier1HeldDecisionsForSession(abrainHome, sessionId);
  return list[0] ?? null;
}

/** Ack only after durable capture success OR terminal reject (drop infinite retry). */
export async function ackTier1HeldDecision(
  abrainHome: string,
  decisionId: string,
): Promise<{ status: "acked" | "missing"; fromPath: string; toPath?: string }> {
  assertDecisionId(decisionId);
  const fromPath = tier1HeldPendingPath(abrainHome, decisionId);
  const ackedDir = tier1HeldAckedDir(abrainHome);
  await fs.mkdir(ackedDir, { recursive: true, mode: 0o700 });
  const toPath = path.join(ackedDir, `${decisionId}.json`);
  try {
    await fs.rename(fromPath, toPath);
    await fsyncDirectory(ackedDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    void pruneAckedHeld(abrainHome, 64).catch(() => undefined);
    return { status: "acked", fromPath, toPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
    const raw = await fs.readFile(fromPath);
    await durableAtomicWriteFile(toPath, raw, { mode: 0o600 });
    await fs.unlink(fromPath);
    await fsyncDirectory(ackedDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    return { status: "acked", fromPath, toPath };
  }
}

async function pruneAckedHeld(abrainHome: string, keep: number): Promise<void> {
  const dir = tier1HeldAckedDir(abrainHome);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return; }
  const rows: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try { rows.push({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs }); } catch { /* skip */ }
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const row of rows.slice(0, Math.max(0, rows.length - keep))) {
    await fs.unlink(path.join(dir, row.name)).catch(() => undefined);
  }
}

/**
 * Transient constraint-evidence capture failures that must HOLD (not consume,
 * not degrade provenance) and retry the exact authorized decision.
 *
 * Terminal: invalid / blocked / path_violation / collision / sanitizer — same
 * input fails identically; advance + recall flag is the net.
 */
export function isTransientConstraintEvidenceAppendFailure(reason: string): boolean {
  if (!reason.startsWith("constraint_evidence_append_failed:")) return false;
  const detail = reason.slice("constraint_evidence_append_failed:".length);
  if (detail === "write_failed") return true;
  // Normalized codes emitted by normalizeConstraintEvidenceAppendError.
  const TRANSIENT_CODES = new Set([
    "write_failed",
    "RECOVERY_QUARANTINED",
    "CANONICAL_MUTATION_BUSY",
    "CANONICAL_SCAN_BUSY",
    "CANONICAL_SCAN_LOCK_FAILED",
    "CANONICAL_STARTUP_BLOCKED",
    "CANONICAL_DRAIN_TRANSIENT",
  ]);
  if (TRANSIENT_CODES.has(detail)) return true;
  // Prefix form: CANONICAL_DRAIN_RECOVERY_QUARANTINED etc.
  if (detail.startsWith("CANONICAL_DRAIN_")) return true;
  // Legacy un-normalized message shapes still in the wild / mid-flight.
  const lower = detail.toLowerCase();
  if (lower.includes("recovery_quarantined")) return true;
  if (lower.includes("canonical startup barrier blocked")) return true;
  if (lower.includes("canonical_mutation_busy")) return true;
  if (lower.includes("canonical_scan_busy")) return true;
  if (lower.includes("canonical_scan_lock_failed")) return true;
  if (/drain ended in\s+\w+/i.test(detail)) {
    if (/ended in\s+(index_converged|empty|metadata_deferred|consumed)\b/i.test(detail)) return false;
    return true;
  }
  return false;
}

/** Normalize thrown/status failures into stable reason suffixes for HOLD taxonomy. */
export function normalizeConstraintEvidenceAppendError(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const code = String((error as { code: string }).code);
    if (
      code === "RECOVERY_QUARANTINED"
      || code === "CANONICAL_MUTATION_BUSY"
      || code === "CANONICAL_SCAN_BUSY"
      || code === "CANONICAL_SCAN_LOCK_FAILED"
    ) {
      return code;
    }
  }
  const msg = error instanceof Error ? error.message : String(error ?? "unknown");
  if (/RECOVERY_QUARANTINED/i.test(msg)) return "RECOVERY_QUARANTINED";
  if (/canonical startup barrier blocked/i.test(msg)) return "CANONICAL_STARTUP_BLOCKED";
  if (/CANONICAL_MUTATION_BUSY/i.test(msg)) return "CANONICAL_MUTATION_BUSY";
  if (/CANONICAL_SCAN_BUSY/i.test(msg)) return "CANONICAL_SCAN_BUSY";
  if (/CANONICAL_SCAN_LOCK_FAILED/i.test(msg)) return "CANONICAL_SCAN_LOCK_FAILED";
  const drain = msg.match(/canonical drain ended in\s+(\w+)/i);
  if (drain) {
    const status = drain[1]!;
    if (status === "index_converged" || status === "empty" || status === "metadata_deferred" || status === "consumed") {
      return msg.slice(0, 500);
    }
    return `CANONICAL_DRAIN_${status.toUpperCase()}`;
  }
  // append() status passthrough
  if (msg === "write_failed" || msg === "invalid" || msg === "blocked" || msg === "collision" || msg === "path_violation") {
    return msg;
  }
  return msg.slice(0, 500) || "unknown";
}

/** Rehydrate held signal into CorrectionSignal for tryAutoWriteLane. */
export function heldSignalAsCorrectionSignal(held: Tier1HeldAuthorizedDecision): CorrectionSignal {
  return {
    ...held.signal,
    signal_found: true,
    typing: "durable",
    provenance: "user-expressed",
    rule_scope: held.signal.rule_scope,
  };
}
