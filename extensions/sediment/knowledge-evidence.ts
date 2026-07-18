import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicWriteFile } from "../_shared/durable-write";
import {
  CURRENT_KNOWLEDGE_L2,
  knowledgeProjectionEntryRelativePathV1,
  knowledgeProjectionManifestRelativePathV1,
} from "../_shared/canonical-l2-contract";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined, type JcsJsonValue } from "../_shared/jcs";
import { scanWholeL1Validated, validateL1WritePreflight } from "../_shared/l1-schema-registry";
import { slugify } from "../memory/utils";
import type { ProjectEntryDraft, WriteProjectEntryResult, WriterAuditContext } from "./writer";
import type { SedimentSettings } from "./settings";

type JsonValue = JcsJsonValue;

export type KnowledgeEvidenceOperation = "create" | "update" | "merge" | "archive" | "supersede" | "delete";
export type KnowledgeEvidenceScope = "project" | "world";

export interface KnowledgeEvidenceLlmExtraction {
  model: string;
  prompt_version: string;
  prompt_hash: string;
  input_hash: string;
  output_hash: string;
  parsed_output_hash?: string;
  acceptance: "accepted_for_event_append" | "diagnostic_only";
}

export interface KnowledgeEvidenceEventBodyV1 {
  event_schema_version: "knowledge-evidence-event/v1";
  event_type: "knowledge_entry_observed";
  created_at_utc: string;
  device_id: string;
  device_event_seq?: number;
  producer_nonce?: string;
  causal_parents: string[];
  session_id: string;
  turn_id: string;
  actor: { role: "assistant"; id: "sediment" };
  source: {
    channel: "agent_end" | "manual" | "replay";
    source_ref: string;
    candidate_id?: string;
    correlation_id?: string;
  };
  intent: {
    domain_hint: "knowledge";
    operation_hint: KnowledgeEvidenceOperation;
    confidence?: number;
  };
  scope: {
    kind: KnowledgeEvidenceScope;
    project_id?: string;
  };
  payload: {
    slug: string;
    title: string;
    kind: string;
    status: string;
    provenance: string;
    confidence: number;
    compiled_truth: string;
    trigger_phrases: string[];
    derives_from: string[];
    timeline_note?: string;
  };
  sanitizer: {
    sanitizer_name: string;
    sanitizer_version: string;
    status: "passed" | "redacted" | "blocked";
    replacements_count: number;
    blocked_reason?: string;
  };
  legacy_parallel_write: {
    attempted: boolean;
    status: string;
    path?: string;
    git_commit?: string | null;
    reason?: string;
  };
  producer: {
    name: "sediment.knowledge-event-writer";
    version: "adr0039-p5";
  };
  llm_extraction?: KnowledgeEvidenceLlmExtraction;
}

export interface KnowledgeEvidenceEnvelopeV1 {
  schema: "knowledge-evidence-envelope/v1";
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: KnowledgeEvidenceEventBodyV1;
}

export interface KnowledgeEvidenceDiagnostic {
  code: "KE_APPEND_OK" | "KE_APPEND_IDEMPOTENT_DUPLICATE" | "KE_RECOVERED_EMPTY_RESIDUE" | "KE_HASH_PATH_COLLISION" | "KE_APPEND_FAILED";
  message: string;
  data?: Record<string, JsonValue>;
}

export interface AppendKnowledgeEvidenceEventResult {
  ok: boolean;
  status: "appended" | "idempotent_duplicate" | "collision" | "write_failed" | "path_violation";
  eventId?: string;
  filePath?: string;
  envelope?: KnowledgeEvidenceEnvelopeV1;
  error?: string;
  recoveredEmptyResidue?: boolean;
  diagnostics?: KnowledgeEvidenceDiagnostic[];
}

export interface ProjectKnowledgeEvidenceResult {
  ok: boolean;
  status: "projected" | "removed" | "disabled" | "invalid" | "write_failed";
  outputPath?: string;
  manifestPath?: string;
  error?: string;
}

export interface AppendKnowledgeEvidenceForWriteOptions {
  abrainHome: string;
  projectId: string;
  scope: KnowledgeEvidenceScope;
  draft: ProjectEntryDraft;
  result: WriteProjectEntryResult;
  settings: SedimentSettings;
  auditContext?: WriterAuditContext;
  sessionId?: string;
  operation?: KnowledgeEvidenceOperation;
  channel?: "agent_end" | "manual" | "replay";
  turnId?: string;
  createdAtUtc?: string;
  projectEvent?: boolean;
  causalParents?: string[];
  sanitizer?: KnowledgeEvidenceEventBodyV1["sanitizer"];
  legacyParallelWrite?: {
    attempted?: boolean;
    status?: string;
    path?: string;
    gitCommit?: string | null;
    reason?: string;
  };
}

export interface AppendKnowledgeEvidenceForWriteResult {
  body?: KnowledgeEvidenceEventBodyV1;
  append: AppendKnowledgeEvidenceEventResult;
  projection?: ProjectKnowledgeEvidenceResult;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  return canonicalizeJcs(value);
}

function toJsonValue(value: unknown): JsonValue {
  return normalizeJcsValueOmittingUndefined(value);
}

function evidenceRoot(abrainHome: string): string {
  return path.resolve(abrainHome, "l1", "events");
}

function abrainStateRoot(abrainHome: string): string {
  return path.resolve(abrainHome, ".state");
}

/** ADR 0039 B1: resolve the Knowledge L2 projection root.
 *  "state" (default) keeps the runtime-cache location; "repo" moves it to the
 *  git-trackable l2/ namespace. Exported so reconcile / L3 mirror resolve the
 *  same root from the same flag. */
export function knowledgeProjectionRoot(
  abrainHome: string,
  settings?: { knowledgeProjector?: { l2OutputRoot?: string } },
): string {
  if (settings?.knowledgeProjector?.l2OutputRoot === "repo") {
    return path.resolve(abrainHome, "l2", "views", "knowledge");
  }
  return path.resolve(abrainHome, ".state", "sediment", "knowledge-projection");
}

function stateRoot(abrainHome: string, settings?: { knowledgeProjector?: { l2OutputRoot?: string } }): string {
  return knowledgeProjectionRoot(abrainHome, settings);
}

export function knowledgeEvidenceEventRelativePath(eventId: string): string {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error(`invalid knowledge evidence event id: ${eventId}`);
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

export function knowledgeEvidenceEventPath(abrainHome: string, eventId: string): string {
  return path.join(path.resolve(abrainHome), knowledgeEvidenceEventRelativePath(eventId));
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function guardEventPath(abrainHome: string, targetPath: string): boolean {
  return isPathInside(evidenceRoot(abrainHome), targetPath);
}

async function readOrCreateDeviceId(abrainHome: string): Promise<string> {
  const stateDir = abrainStateRoot(abrainHome);
  const file = path.join(stateDir, "device-id");
  const existing = await fs.readFile(file, "utf-8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? null : Promise.reject(err));
  const trimmed = existing?.trim();
  if (trimmed && /^[A-Za-z0-9-]{8,64}$/.test(trimmed)) return trimmed;
  const id = crypto.randomUUID();
  await fs.mkdir(stateDir, { recursive: true });
  await durableAtomicWriteFile(file, `${id}\n`, { mode: 0o600 });
  return (await fs.readFile(file, "utf-8")).trim();
}

export function knowledgeEvidenceBodyHash(body: KnowledgeEvidenceEventBodyV1): string {
  return sha256Hex(canonicalJson(toJsonValue(body)));
}

function knowledgeEvidenceEnvelopeJson(envelope: KnowledgeEvidenceEnvelopeV1): string {
  return `${canonicalJson(toJsonValue(envelope))}\n`;
}

function createEnvelope(body: KnowledgeEvidenceEventBodyV1): KnowledgeEvidenceEnvelopeV1 {
  const bodyHash = knowledgeEvidenceBodyHash(body);
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

export function renderKnowledgeEvidenceEnvelopeJson(envelope: KnowledgeEvidenceEnvelopeV1): string {
  return knowledgeEvidenceEnvelopeJson(envelope);
}

export function verifyKnowledgeEvidenceEnvelope(envelope: KnowledgeEvidenceEnvelopeV1): { ok: true } | { ok: false; reason: string } {
  if (envelope.schema !== "knowledge-evidence-envelope/v1") return { ok: false, reason: "unsupported_schema" };
  if (envelope.canonicalization !== "RFC8785-JCS" || envelope.hash_alg !== "sha256") return { ok: false, reason: "unsupported_hash_metadata" };
  if (!/^[0-9a-f]{64}$/.test(envelope.event_id) || !/^[0-9a-f]{64}$/.test(envelope.body_hash)) return { ok: false, reason: "invalid_hash_shape" };
  const bodyHash = knowledgeEvidenceBodyHash(envelope.body);
  if (envelope.event_id !== bodyHash || envelope.body_hash !== bodyHash) return { ok: false, reason: "body_hash_mismatch" };
  const body = envelope.body;
  if (body.event_schema_version !== "knowledge-evidence-event/v1" || body.event_type !== "knowledge_entry_observed") return { ok: false, reason: "unsupported_body_schema" };
  if (!body.device_id || (!body.device_event_seq && !body.producer_nonce)) return { ok: false, reason: "missing_device_identity" };
  if (!Array.isArray(body.causal_parents) || !body.causal_parents.every((item) => /^[0-9a-f]{64}$/.test(item))) return { ok: false, reason: "invalid_causal_parents" };
  if (!body.session_id || !body.turn_id) return { ok: false, reason: "missing_anchor" };
  if (!body.sanitizer || body.sanitizer.status === "blocked") return { ok: false, reason: "sanitizer_blocked_or_missing" };
  return { ok: true };
}

function canonicalizeExistingEnvelopeJson(input: string): string | null {
  try {
    return knowledgeEvidenceEnvelopeJson(JSON.parse(input) as KnowledgeEvidenceEnvelopeV1);
  } catch {
    return null;
  }
}

function knowledgeEvidenceDiagnostic(
  code: KnowledgeEvidenceDiagnostic["code"],
  message: string,
  data?: Record<string, JsonValue>,
): KnowledgeEvidenceDiagnostic {
  return data ? { code, message, data } : { code, message };
}

function knowledgeCollisionReason(existing: string, expected: string): string {
  if (canonicalizeExistingEnvelopeJson(existing) === null) return "existing_unparseable";
  return existing === expected ? "identical" : "content_mismatch";
}

export async function appendKnowledgeEvidenceEvent(args: { abrainHome: string; body: KnowledgeEvidenceEventBodyV1 }): Promise<AppendKnowledgeEvidenceEventResult> {
  let envelope: KnowledgeEvidenceEnvelopeV1;
  try {
    envelope = createEnvelope(args.body);
  } catch (err) {
    return { ok: false, status: "write_failed", error: err instanceof Error ? err.message : String(err) };
  }
  const eventId = envelope.event_id;
  const filePath = knowledgeEvidenceEventPath(args.abrainHome, eventId);
  if (!guardEventPath(args.abrainHome, filePath)) return { ok: false, status: "path_violation", eventId, filePath, envelope };
  const validation = verifyKnowledgeEvidenceEnvelope(envelope);
  if (!validation.ok) return { ok: false, status: "write_failed", eventId, filePath, envelope, error: validation.reason };
  // Canonical-path R3.4.2 P1-S3 write gate: registry role/producer/path and
  // lstat+realpath symlink-escape validation before any durable L1 write.
  try {
    await validateL1WritePreflight({
      abrainHome: args.abrainHome,
      envelope,
      targetPath: filePath,
      expected: { domain: "knowledge", role: "canonical" },
    });
  } catch (err) {
    return { ok: false, status: "write_failed", eventId, filePath, envelope, error: err instanceof Error ? err.message : String(err) };
  }
  const content = knowledgeEvidenceEnvelopeJson(envelope);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await fs.readFile(filePath, "utf-8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? null : Promise.reject(err));
    if (existing !== null) {
      if (existing === content || canonicalizeExistingEnvelopeJson(existing) === content) {
        return {
          ok: true,
          status: "idempotent_duplicate",
          eventId,
          filePath,
          envelope,
          diagnostics: [knowledgeEvidenceDiagnostic("KE_APPEND_IDEMPOTENT_DUPLICATE", "knowledge evidence event already exists with identical content", { eventId, filePath })],
        };
      }
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        await durableAtomicWriteFile(filePath, content);
        return {
          ok: true,
          status: "appended",
          eventId,
          filePath,
          envelope,
          recoveredEmptyResidue: true,
          diagnostics: [knowledgeEvidenceDiagnostic("KE_RECOVERED_EMPTY_RESIDUE", "knowledge evidence event recovered an empty crash residue", { eventId, filePath, recovered: "recovered_empty_residue" })],
        };
      }
      const reason = knowledgeCollisionReason(existing, content);
      return {
        ok: false,
        status: "collision",
        eventId,
        filePath,
        envelope,
        error: `knowledge evidence event path collision: ${reason}`,
        diagnostics: [knowledgeEvidenceDiagnostic("KE_HASH_PATH_COLLISION", "knowledge evidence event path already exists with different content", { eventId, filePath, reason })],
      };
    }
    await durableAtomicWriteFile(filePath, content);
    return {
      ok: true,
      status: "appended",
      eventId,
      filePath,
      envelope,
      diagnostics: [knowledgeEvidenceDiagnostic("KE_APPEND_OK", "knowledge evidence event appended", { eventId, filePath })],
    };
  } catch (err) {
    return { ok: false, status: "write_failed", eventId, filePath, envelope, error: err instanceof Error ? err.message : String(err) };
  }
}

function markdownString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function markdownList(key: string, values: string[]): string[] {
  if (!values.length) return [];
  return [key + ":", ...values.map((value) => `  - ${markdownString(value)}`)];
}

function normalizeCompiledTruth(title: string, body: string): string {
  let text = body.trim().replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  text = text.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
}

function knowledgeLlmExtractionForWrite(args: AppendKnowledgeEvidenceForWriteOptions, slug: string): KnowledgeEvidenceLlmExtraction | undefined {
  const model = args.settings.curatorModel || args.settings.extractorModel;
  if (!model) return undefined;
  const promptVersion = "knowledge-evidence-writer/v1";
  const input = {
    operation: args.operation || "create",
    scope: args.scope,
    project_id: args.projectId,
    draft: {
      title: args.draft.title,
      kind: args.draft.kind,
      status: args.draft.status || "provisional",
      provenance: args.draft.provenance || "assistant-observed",
      confidence: args.draft.confidence,
      compiled_truth_hash: sha256Hex(args.draft.compiledTruth),
      trigger_phrases: args.draft.triggerPhrases ?? [],
      derives_from: args.draft.derivesFrom ?? [],
      timeline_note_hash: args.draft.timelineNote ? sha256Hex(args.draft.timelineNote) : undefined,
    },
    legacy_result: {
      slug,
      status: args.result.status,
      reason: args.result.reason,
    },
  };
  const output = {
    slug,
    title: args.draft.title,
    kind: args.draft.kind,
    status: args.draft.status || "provisional",
    compiled_truth_hash: sha256Hex(args.draft.compiledTruth),
  };
  return {
    model,
    prompt_version: promptVersion,
    prompt_hash: sha256Hex(promptVersion),
    input_hash: sha256Hex(canonicalJson(toJsonValue(input))),
    output_hash: sha256Hex(canonicalJson(toJsonValue(output))),
    parsed_output_hash: sha256Hex(canonicalJson(toJsonValue(output))),
    acceptance: "accepted_for_event_append",
  };
}

function hashKnowledgeProjectionMarkdownBytes(markdownWithoutOutputHash: string): string {
  return sha256Hex(markdownWithoutOutputHash);
}

function blankKnowledgeProjectionOutputHash(markdown: string): string | undefined {
  if (!markdown.startsWith("---\n")) return undefined;
  const frontmatterEnd = markdown.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) return undefined;
  const frontmatter = markdown.slice(0, frontmatterEnd);
  const outputHashLines = frontmatter.match(/^sediment_output_hash:.*$/gm) ?? [];
  if (outputHashLines.length !== 1) return undefined;
  return frontmatter.replace(/^sediment_output_hash:.*$/m, "sediment_output_hash: ") + markdown.slice(frontmatterEnd);
}

export function knowledgeProjectionOutputHashFromMarkdownBytes(markdown: string): string | undefined {
  const withoutOutputHash = blankKnowledgeProjectionOutputHash(markdown);
  return withoutOutputHash === undefined ? undefined : hashKnowledgeProjectionMarkdownBytes(withoutOutputHash);
}

export function renderKnowledgeProjectionMarkdown(body: KnowledgeEvidenceEventBodyV1, eventId: string): string {
  const outputWithoutHash = renderKnowledgeProjectionMarkdownBytes(body, eventId, "");
  const outputHash = hashKnowledgeProjectionMarkdownBytes(outputWithoutHash);
  return renderKnowledgeProjectionMarkdownBytes(body, eventId, outputHash);
}

interface KnowledgeRenderOverrides {
  created?: string;
  updated?: string;
  setHash?: string;
}

function renderKnowledgeProjectionMarkdownBytes(
  body: KnowledgeEvidenceEventBodyV1,
  eventId: string,
  outputHash: string,
  overrides?: KnowledgeRenderOverrides,
): string {
  const timestamp = body.created_at_utc;
  const created = overrides?.created ?? timestamp;
  const updated = overrides?.updated ?? timestamp;
  const setHash = overrides?.setHash ?? eventId;
  const payload = body.payload;
  const id = body.scope.kind === "world" ? `world:${payload.slug}` : `project:${body.scope.project_id}:${payload.slug}`;
  const frontmatter = [
    "---",
    `id: ${id}`,
    `scope: ${body.scope.kind}`,
    `kind: ${payload.kind}`,
    `status: ${payload.status}`,
    `confidence: ${payload.confidence}`,
    `provenance: ${markdownString(payload.provenance)}`,
    `schema_version: ${CURRENT_KNOWLEDGE_L2.entrySchemaVersion}`,
    `title: ${markdownString(payload.title)}`,
    `created: ${created}`,
    `updated: ${updated}`,
    `sediment_projection: ${CURRENT_KNOWLEDGE_L2.projection}`,
    `sediment_projector: ${CURRENT_KNOWLEDGE_L2.projector}`,
    `sediment_projector_version: ${CURRENT_KNOWLEDGE_L2.projectorVersion}`,
    `sediment_template_version: ${CURRENT_KNOWLEDGE_L2.templateVersion}`,
    `sediment_input_event_set_hash: ${setHash}`,
    `sediment_output_hash: ${outputHash}`,
    `sediment_watermark_event_id: ${eventId}`,
    `sediment_event_id: ${eventId}`,
    ...markdownList("trigger_phrases", payload.trigger_phrases),
    ...markdownList("derives_from", payload.derives_from),
  ];
  if (body.scope.kind === "project" && body.scope.project_id) frontmatter.push(`project_id: ${markdownString(body.scope.project_id)}`);
  frontmatter.push("---", "");
  return [
    ...frontmatter,
    normalizeCompiledTruth(payload.title, payload.compiled_truth),
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${body.session_id} | projected | ${payload.timeline_note || "projected from Knowledge Evidence Event"}`,
    "",
  ].join("\n");
}

// ─── ADR 0039 B2: deterministic topological set projection ───────────────────

export interface KnowledgeEventNode {
  eventId: string;
  body: KnowledgeEvidenceEventBodyV1;
}

export function knowledgeIdentityKey(body: KnowledgeEvidenceEventBodyV1): string {
  return body.scope.kind === "world"
    ? `world::${body.payload.slug}`
    : `project:${body.scope.project_id || "unknown"}:${body.payload.slug}`;
}

/** Canonical-path R3.4.2 P1-S3: whole-L1 scan through the central schema-role
 *  registry. Every event file (any domain) is envelope/hash/path/role/producer
 *  validated before the knowledge fold sees a single node; unknown or corrupt
 *  events fail the scan closed instead of being silently skipped. */
export async function collectAllKnowledgeEventNodes(abrainHome: string): Promise<KnowledgeEventNode[]> {
  const scan = await scanWholeL1Validated({ abrainHome, domains: ["knowledge"], roles: ["canonical"] });
  return scan.selected.map((record) => ({
    eventId: record.eventId,
    body: record.body as unknown as KnowledgeEvidenceEventBodyV1,
  }));
}

/** Collect every L1 knowledge event sharing the given (scope, slug) identity. */
export async function collectKnowledgeEventSet(abrainHome: string, identity: string): Promise<KnowledgeEventNode[]> {
  const nodes = await collectAllKnowledgeEventNodes(abrainHome);
  return nodes.filter((node) => knowledgeIdentityKey(node.body) === identity);
}

export interface ReprojectAllKnowledgeResult {
  identities: number;
  projected: number;
  removed: number;
  failed: number;
  failures: string[];
  writtenPaths: string[];
}

export interface Adr0039L3PostWriteSyncResult {
  ok: boolean;
  dbPath: string;
  counts: {
    l1Events: number;
    eventEdges: number;
    l2Views: number;
    searchCorpusRows: number;
    projectorState: number;
    jobs: number;
    diagnostics: number;
  };
  failures: string[];
}

const ADR0039_L3_RELEVANT_WRITE_STATUSES = new Set(["created", "updated", "merged", "archived", "superseded", "deleted"]);

type Adr0039L3WriteResultLike = {
  status?: unknown;
  knowledgeEvidenceEvent?: unknown;
};

function hasSuccessfulKnowledgeEvidenceEvent(result: Adr0039L3WriteResultLike): boolean {
  const event = result.knowledgeEvidenceEvent;
  if (!event || typeof event !== "object") return false;
  const append = (event as { append?: unknown }).append;
  const projection = (event as { projection?: unknown }).projection;
  return !!(
    (append && typeof append === "object" && (append as { ok?: unknown }).ok === true)
    || (projection && typeof projection === "object")
  );
}

export function hasAdr0039L3RelevantWriteResult(results: readonly Adr0039L3WriteResultLike[] | undefined): boolean {
  return !!results?.some((result) => (
    ADR0039_L3_RELEVANT_WRITE_STATUSES.has(String(result.status))
    && hasSuccessfulKnowledgeEvidenceEvent(result)
  ));
}

export async function syncAdr0039L3AfterKnowledgeWrite(args: {
  abrainHome: string;
  settings?: { knowledgeProjector?: { l2OutputRoot?: string } };
}): Promise<Adr0039L3PostWriteSyncResult | undefined> {
  try {
    const { syncAdr0039L3Store } = await import("./adr0039-l3");
    return await syncAdr0039L3Store({
      abrainHome: args.abrainHome,
      knowledgeLatestDir: path.join(knowledgeProjectionRoot(args.abrainHome, args.settings), "latest"),
    });
  } catch {
    return undefined;
  }
}

/** Full-corpus deterministic reproject of every knowledge identity from L1 to
 *  the L2 projection root. Single O(N) pass: scan L1 once, group nodes by
 *  identity, then fold + write each identity. (Calling
 *  projectKnowledgeEvidenceEvent per identity would re-scan all of L1 each
 *  time => O(N^2).)
 *
 *  Async fs throughout so a multi-thousand-file reproject yields to the event
 *  loop instead of blocking it. Called by
 *  scripts/backfill-legacy-knowledge.mjs --reproject for an explicit CLI full
 *  rebuild; device Git sync does not invoke projection repair. */
export async function reprojectAllKnowledge(
  { abrainHome, settings }: { abrainHome: string; settings?: { knowledgeProjector?: { l2OutputRoot?: string } } },
): Promise<ReprojectAllKnowledgeResult> {
  // Whole-L1 validation completes before a single L2 byte is written; any
  // envelope/hash/path/role/producer violation aborts the reproject closed.
  const byIdentity = new Map<string, KnowledgeEventNode[]>();
  const allNodes = await collectAllKnowledgeEventNodes(abrainHome);
  for (const node of allNodes) {
    const identity = knowledgeIdentityKey(node.body);
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity)!.push(node);
  }

  const projectionRoot = knowledgeProjectionRoot(abrainHome, settings);
  const latestDir = path.join(projectionRoot, "latest");
  let projected = 0;
  let removed = 0;
  let failed = 0;
  const failures: string[] = [];
  const writtenPaths: string[] = [];
  for (const [identity, nodes] of byIdentity) {
    try {
      const proj = renderKnowledgeProjectionFromSet(nodes);
      const body = nodes[0]!.body;
      const relative = knowledgeProjectionEntryRelativePathV1({ scopeKind: body.scope.kind, projectId: body.scope.project_id, slug: body.payload.slug });
      const outputPath = path.join(projectionRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      if (proj.kind === "delete") {
        await fs.rm(outputPath, { force: true });
        removed += 1;
      } else {
        await fs.writeFile(outputPath, proj.markdown!, "utf-8");
        projected += 1;
      }
      writtenPaths.push(outputPath);
    } catch (err) {
      failed += 1;
      failures.push(`${identity}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (allNodes.length > 0) {
    await fs.mkdir(latestDir, { recursive: true });
    const manifestPath = path.join(projectionRoot, ...knowledgeProjectionManifestRelativePathV1().split("/"));
    await fs.writeFile(manifestPath, renderKnowledgeProjectionManifestFromSet(allNodes).json, "utf-8");
    writtenPaths.push(manifestPath);
    await syncAdr0039L3AfterKnowledgeWrite({ abrainHome, settings });
  }
  return { identities: byIdentity.size, projected, removed, failed, failures: failures.slice(0, 10), writtenPaths: Array.from(new Set(writtenPaths)).sort() };
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameLayerKey(node: KnowledgeEventNode): string {
  // ADR 0039 §4.3 same-layer tie-break: created_at_utc, device_id,
  // device_event_seq, event_id (event_id breaks all remaining ties). Explicit
  // UTF-16 code-unit order matches JCS property ordering in every locale.
  const seq = typeof node.body.device_event_seq === "number" ? String(node.body.device_event_seq).padStart(20, "0") : "";
  return [node.body.created_at_utc, node.body.device_id, seq, node.eventId].join("\u0000");
}

/** Kahn topological sort over the in-set causal-parent DAG; same-layer events
 *  use the deterministic tie-break. Cycles fall back to tie-break order. */
export function topoSortKnowledgeEvents(nodes: KnowledgeEventNode[]): KnowledgeEventNode[] {
  const byId = new Map(nodes.map((n) => [n.eventId, n]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) indegree.set(n.eventId, 0);
  for (const n of nodes) {
    for (const parent of n.body.causal_parents || []) {
      if (!byId.has(parent)) continue; // out-of-set parent does not constrain ordering
      indegree.set(n.eventId, (indegree.get(n.eventId) ?? 0) + 1);
      children.set(parent, [...(children.get(parent) ?? []), n.eventId]);
    }
  }
  const ready = nodes.filter((n) => (indegree.get(n.eventId) ?? 0) === 0).sort((a, b) => compareUtf16CodeUnits(sameLayerKey(a), sameLayerKey(b)));
  const out: KnowledgeEventNode[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const node = ready.shift()!;
    if (seen.has(node.eventId)) continue;
    seen.add(node.eventId);
    out.push(node);
    let pushed = false;
    for (const childId of children.get(node.eventId) ?? []) {
      indegree.set(childId, (indegree.get(childId) ?? 0) - 1);
      if ((indegree.get(childId) ?? 0) === 0 && !seen.has(childId)) {
        ready.push(byId.get(childId)!);
        pushed = true;
      }
    }
    if (pushed) ready.sort((a, b) => compareUtf16CodeUnits(sameLayerKey(a), sameLayerKey(b)));
  }
  // Cycle / unreachable remainder: append in deterministic tie-break order.
  if (out.length < nodes.length) {
    for (const n of nodes.filter((x) => !seen.has(x.eventId)).sort((a, b) => compareUtf16CodeUnits(sameLayerKey(a), sameLayerKey(b)))) out.push(n);
  }
  return out;
}

export interface KnowledgeSetProjection {
  /** "delete" when the topologically-last event is a tombstone. */
  kind: "entry" | "delete";
  markdown?: string;
  winnerEventId: string;
  inputEventSetHash: string;
}

export interface KnowledgeEvidenceL1Head {
  winnerEventId: string;
  inputEventSetHash: string;
  projectionKind: "entry" | "delete";
  eventCount: number;
}

export interface KnowledgeProjectionManifestV1 {
  schemaVersion: typeof CURRENT_KNOWLEDGE_L2.manifestSchemaVersion;
  updatedAtUtc: string;
  latestEventId: string;
  latestOutputPath: string;
  latestScope: KnowledgeEvidenceEventBodyV1["scope"];
  latestOperation: KnowledgeEvidenceOperation;
}

export interface RenderedKnowledgeProjectionManifest {
  manifest: KnowledgeProjectionManifestV1;
  json: string;
  winnerEventId: string;
  identityWinnerEventIds: readonly string[];
}

export function resolveKnowledgeManifestOutputPath(projectionRoot: string, manifest: KnowledgeProjectionManifestV1): string {
  const normalized = manifest.latestOutputPath.split("/");
  if (
    path.isAbsolute(manifest.latestOutputPath)
    || manifest.latestOutputPath.includes("\\")
    || normalized.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("knowledge manifest latestOutputPath is not a normalized repo-relative projection path");
  }
  return path.join(projectionRoot, ...normalized);
}

/** Deterministic fold of an event set to one entry. Last non-delete event in
 *  topo order wins the payload; created comes from the earliest event. A single
 *  event with no in-set parents degenerates byte-identically to the per-event
 *  renderer (the B2 acceptance gate). */
export function renderKnowledgeProjectionFromSet(nodes: KnowledgeEventNode[]): KnowledgeSetProjection {
  if (nodes.length === 0) throw new Error("renderKnowledgeProjectionFromSet: empty event set");
  const sorted = topoSortKnowledgeEvents(nodes);
  const winner = sorted[sorted.length - 1]!;
  const earliest = sorted[0]!;
  const sortedIds = sorted.map((n) => n.eventId).slice().sort();
  const inputEventSetHash = sorted.length === 1 ? winner.eventId : sha256Hex(canonicalJson(sortedIds));
  if (winner.body.intent.operation_hint === "delete") {
    return { kind: "delete", winnerEventId: winner.eventId, inputEventSetHash };
  }
  if (sorted.length === 1 && (winner.body.causal_parents?.length ?? 0) === 0) {
    return { kind: "entry", markdown: renderKnowledgeProjectionMarkdown(winner.body, winner.eventId), winnerEventId: winner.eventId, inputEventSetHash };
  }
  const overrides: KnowledgeRenderOverrides = {
    created: earliest.body.created_at_utc,
    updated: winner.body.created_at_utc,
    setHash: inputEventSetHash,
  };
  const withoutHash = renderKnowledgeProjectionMarkdownBytes(winner.body, winner.eventId, "", overrides);
  const outputHash = hashKnowledgeProjectionMarkdownBytes(withoutHash);
  return { kind: "entry", markdown: renderKnowledgeProjectionMarkdownBytes(winner.body, winner.eventId, outputHash, overrides), winnerEventId: winner.eventId, inputEventSetHash };
}

/** Pure manifest renderer over the complete validated Knowledge event set.
 *  Each identity is folded first; the manifest watermark is selected from
 *  those winners. No wall clock or caller event can affect canonical bytes. */
export function renderKnowledgeProjectionManifestFromSet(
  nodes: KnowledgeEventNode[],
): RenderedKnowledgeProjectionManifest {
  if (nodes.length === 0) throw new Error("renderKnowledgeProjectionManifestFromSet: empty event set");
  const byIdentity = new Map<string, KnowledgeEventNode[]>();
  for (const node of nodes) {
    const identity = knowledgeIdentityKey(node.body);
    const current = byIdentity.get(identity) ?? [];
    current.push(node);
    byIdentity.set(identity, current);
  }
  const byId = new Map(nodes.map((node) => [node.eventId, node]));
  const identityWinners = [...byIdentity.values()].map((set) => renderKnowledgeProjectionFromSet(set).winnerEventId);
  const winnerNodes = identityWinners.map((eventId) => byId.get(eventId)!).sort((left, right) => {
    const keyOrder = compareUtf16CodeUnits(sameLayerKey(left), sameLayerKey(right));
    return keyOrder || compareUtf16CodeUnits(left.eventId, right.eventId);
  });
  const winner = winnerNodes[winnerNodes.length - 1]!;
  const body = winner.body;
  const outputPath = knowledgeProjectionEntryRelativePathV1({ scopeKind: body.scope.kind, projectId: body.scope.project_id, slug: body.payload.slug });
  const manifest: KnowledgeProjectionManifestV1 = {
    schemaVersion: CURRENT_KNOWLEDGE_L2.manifestSchemaVersion,
    updatedAtUtc: body.created_at_utc,
    latestEventId: winner.eventId,
    latestOutputPath: outputPath,
    latestScope: body.scope,
    latestOperation: body.intent.operation_hint,
  };
  return {
    manifest,
    json: `${JSON.stringify(manifest, null, 2)}\n`,
    winnerEventId: winner.eventId,
    identityWinnerEventIds: Object.freeze(identityWinners.slice().sort(compareUtf16CodeUnits)),
  };
}

export async function readKnowledgeEvidenceL1Head(args: {
  abrainHome: string;
  scope: KnowledgeEvidenceScope;
  projectId?: string;
  slug: string;
}): Promise<KnowledgeEvidenceL1Head | undefined> {
  const identity = args.scope === "world" ? `world::${args.slug}` : `project:${args.projectId || "unknown"}:${args.slug}`;
  const nodes = await collectKnowledgeEventSet(args.abrainHome, identity);
  if (nodes.length === 0) return undefined;
  const projection = renderKnowledgeProjectionFromSet(nodes);
  return {
    winnerEventId: projection.winnerEventId,
    inputEventSetHash: projection.inputEventSetHash,
    projectionKind: projection.kind,
    eventCount: nodes.length,
  };
}

export async function projectKnowledgeEvidenceEvent(args: { abrainHome: string; envelope: KnowledgeEvidenceEnvelopeV1; settings: SedimentSettings }): Promise<ProjectKnowledgeEvidenceResult> {
  if (!args.settings.knowledgeProjector.enabled) return { ok: false, status: "disabled" };
  const body = args.envelope.body;
  if (body.event_schema_version !== "knowledge-evidence-event/v1" || body.intent.domain_hint !== "knowledge") return { ok: false, status: "invalid" };
  const root = stateRoot(args.abrainHome, args.settings);
  const outputPath = path.join(root, ...knowledgeProjectionEntryRelativePathV1({ scopeKind: body.scope.kind, projectId: body.scope.project_id, slug: body.payload.slug }).split("/"));
  const manifestPath = path.join(root, ...knowledgeProjectionManifestRelativePathV1().split("/"));
  if (!isPathInside(root, outputPath) || !isPathInside(root, manifestPath)) return { ok: false, status: "invalid", error: "projection path escaped state root" };
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    // ADR 0039 B2: in "topo" mode the entry is the deterministic fold of ALL
    // events sharing the (scope, slug) identity; "single" keeps the per-event
    // overwrite. A single event degenerates byte-identically across both.
    let removed = body.intent.operation_hint === "delete";
    if (args.settings.knowledgeProjector.projectionMode === "topo") {
      const set = await collectKnowledgeEventSet(args.abrainHome, knowledgeIdentityKey(body));
      const projection = renderKnowledgeProjectionFromSet(set.length > 0 ? set : [{ eventId: args.envelope.event_id, body }]);
      if (projection.kind === "delete") {
        await fs.rm(outputPath, { force: true });
        removed = true;
      } else {
        await fs.writeFile(outputPath, projection.markdown!, "utf-8");
        removed = false;
      }
    } else if (body.intent.operation_hint === "delete") {
      await fs.rm(outputPath, { force: true });
    } else {
      await fs.writeFile(outputPath, renderKnowledgeProjectionMarkdown(body, args.envelope.event_id), "utf-8");
    }
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const allNodes = await collectAllKnowledgeEventNodes(args.abrainHome);
    const manifest = renderKnowledgeProjectionManifestFromSet(
      allNodes.length > 0 ? allNodes : [{ eventId: args.envelope.event_id, body }],
    );
    await fs.writeFile(manifestPath, manifest.json, "utf-8");
    return { ok: true, status: removed ? "removed" : "projected", outputPath, manifestPath };
  } catch (err) {
    return { ok: false, status: "write_failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildKnowledgeEvidenceBodyForWrite(args: AppendKnowledgeEvidenceForWriteOptions): Promise<KnowledgeEvidenceEventBodyV1> {
  const now = args.createdAtUtc || new Date().toISOString();
  const slug = args.result.slug || slugify(args.draft.title);
  const sessionId = args.sessionId || args.auditContext?.sessionId || args.draft.sessionId || "unknown-session";
  const turnId = args.turnId || "unknown-turn";
  const deviceId = await readOrCreateDeviceId(args.abrainHome);
  const legacyWrite = args.legacyParallelWrite;
  const producerNonce = `knowledge:${now}:${sessionId}:${turnId}:${slug}:${args.operation || "create"}:${sha256Hex(JSON.stringify({ result: args.result.status, path: args.result.path ?? "", legacyWriteAttempted: legacyWrite?.attempted ?? true }))}`;
  const llmExtraction = knowledgeLlmExtractionForWrite(args, slug);
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: now,
    device_id: deviceId,
    producer_nonce: producerNonce,
    causal_parents: args.causalParents?.slice().sort() ?? [],
    session_id: sessionId,
    turn_id: turnId,
    actor: { role: "assistant", id: "sediment" },
    source: {
      channel: args.channel || "agent_end",
      source_ref: `sediment:${args.auditContext?.lane || "writer"}:${args.result.status}:${slug}`,
      ...(args.auditContext?.candidateId ? { candidate_id: args.auditContext.candidateId } : {}),
      ...(args.auditContext?.correlationId ? { correlation_id: args.auditContext.correlationId } : {}),
    },
    intent: {
      domain_hint: "knowledge",
      operation_hint: args.operation || "create",
      confidence: typeof args.draft.confidence === "number" ? Math.max(0, Math.min(1, args.draft.confidence / 10)) : undefined,
    },
    scope: args.scope === "world" ? { kind: "world" } : { kind: "project", project_id: args.projectId },
    payload: {
      slug,
      title: args.draft.title,
      kind: args.draft.kind,
      status: args.draft.status || "provisional",
      provenance: args.draft.provenance || "assistant-observed",
      confidence: Math.min(10, Math.max(0, Math.round(args.draft.confidence ?? 3))),
      compiled_truth: args.draft.compiledTruth,
      trigger_phrases: args.draft.triggerPhrases ?? [],
      derives_from: args.draft.derivesFrom ?? [],
      ...(args.draft.timelineNote ? { timeline_note: args.draft.timelineNote } : {}),
    },
    sanitizer: args.sanitizer ?? {
      sanitizer_name: "sediment.knowledge-evidence.default",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    legacy_parallel_write: {
      attempted: legacyWrite?.attempted ?? true,
      status: legacyWrite?.status ?? args.result.status,
      ...((legacyWrite?.path ?? args.result.path) ? { path: legacyWrite?.path ?? args.result.path } : {}),
      ...("gitCommit" in args.result || legacyWrite?.gitCommit !== undefined ? { git_commit: legacyWrite?.gitCommit ?? args.result.gitCommit ?? null } : {}),
      ...((legacyWrite?.reason ?? args.result.reason) ? { reason: legacyWrite?.reason ?? args.result.reason } : {}),
    },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
    ...(llmExtraction ? { llm_extraction: llmExtraction } : {}),
  };
}

export async function appendKnowledgeEvidenceForWrite(args: AppendKnowledgeEvidenceForWriteOptions): Promise<AppendKnowledgeEvidenceForWriteResult> {
  if (!args.settings.knowledgeEvidenceEventWriter.enabled) return { append: { ok: false, status: "write_failed", error: "knowledge_event_writer_disabled" } };
  const body = await buildKnowledgeEvidenceBodyForWrite(args);
  const append = await appendKnowledgeEvidenceEvent({ abrainHome: args.abrainHome, body });
  const projection = append.ok && append.envelope && args.projectEvent !== false && args.settings.knowledgeProjector.projectOnWrite
    ? await projectKnowledgeEvidenceEvent({ abrainHome: args.abrainHome, envelope: append.envelope, settings: args.settings })
    : undefined;
  return { body, append, ...(projection ? { projection } : {}) };
}

/** Recursively list *.md projection files under root with mtime+size (stat),
 *  honoring a wall-clock deadline. Returns [] if root missing. manifest.json is
 *  excluded (it is not an entry). */
async function statProjectionFiles(
  root: string,
  scope: KnowledgeEvidenceScope,
  label: string,
  deadlineAt: number,
): Promise<{ files: Array<{ file: string; scope: KnowledgeEvidenceScope; label: string; mtimeMs: number; size: number }>; deadlineHit: boolean }> {
  const out: Array<{ file: string; scope: KnowledgeEvidenceScope; label: string; mtimeMs: number; size: number }> = [];
  let deadlineHit = false;
  async function walk(dir: string): Promise<void> {
    if (Date.now() >= deadlineAt) { deadlineHit = true; return; }
    let ents: Array<{ name: string; isDir: boolean; isFile: boolean }>;
    try {
      ents = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    } catch { return; }
    for (const e of ents) {
      if (Date.now() >= deadlineAt) { deadlineHit = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDir) { await walk(full); if (deadlineHit) return; continue; }
      if (!e.isFile || !e.name.endsWith(".md")) continue;
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      out.push({ file: full, scope, label, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  const rootStat = await fs.stat(root).catch(() => null);
  if (rootStat?.isDirectory()) await walk(root);
  return { files: out, deadlineHit };
}

export async function readKnowledgeProjectionStores(args: { abrainHome: string; projectId?: string; settings: SedimentSettings }): Promise<Array<{ scope: KnowledgeEvidenceScope; root: string; label: string; files?: string[] }>> {
  if (!args.settings.knowledgeProjector.enabled || !args.settings.knowledgeProjector.hotOverlayEnabled) return [];
  const latest = path.join(stateRoot(args.abrainHome, args.settings), "latest");
  // Defensive defaults: direct callers / older configs may omit hotOverlay.
  const ho = (args.settings.knowledgeProjector as { hotOverlay?: { maxEntries?: number; maxTokens?: number; deadlineMs?: number } }).hotOverlay;
  const budget = {
    maxEntries: Math.max(1, Math.floor(ho?.maxEntries ?? 500)),
    maxTokens: Math.max(1_000, Math.floor(ho?.maxTokens ?? 2_000_000)),
    deadlineMs: Math.max(1_000, Math.floor(ho?.deadlineMs ?? 30_000)),
  };
  const deadlineAt = Date.now() + budget.deadlineMs;

  // ADR 0039 B-prep blocker③ (§6 bounded hot overlay): enumerate candidate
  // projection files across both scope roots, then keep only the FRESHEST set
  // within a SHARED count + token budget under a wall-clock deadline. token ≈
  // size/4 (estimated from stat, no file read). The OVERLAY role must never grow
  // unbounded; the post-flip stable view is a separate primary store, not this.
  const roots: Array<{ scope: KnowledgeEvidenceScope; root: string; label: string }> = [];
  if (args.projectId) roots.push({ scope: "project", root: path.join(latest, "projects", args.projectId), label: "knowledge-projection-project" });
  roots.push({ scope: "world", root: path.join(latest, "world"), label: "knowledge-projection-world" });

  const candidates: Array<{ file: string; scope: KnowledgeEvidenceScope; label: string; root: string; mtimeMs: number; size: number }> = [];
  let deadlineHit = false;
  for (const r of roots) {
    const res = await statProjectionFiles(r.root, r.scope, r.label, deadlineAt);
    deadlineHit = deadlineHit || res.deadlineHit;
    for (const f of res.files) candidates.push({ ...f, root: r.root });
  }

  // Freshest-first within shared budget.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const tokenOf = (size: number): number => Math.ceil(size / 4);
  const selected: typeof candidates = [];
  let tokens = 0;
  for (const c of candidates) {
    if (selected.length >= budget.maxEntries) break;
    const t = tokenOf(c.size);
    if (tokens + t > budget.maxTokens && selected.length > 0) break;
    selected.push(c);
    tokens += t;
  }
  const truncated = selected.length < candidates.length;

  if (truncated || deadlineHit) {
    // Auditable overflow diagnostic (non-fatal; overlay is bounded not dropped).
    // MUST land in gitignored .state — NOT under stateRoot, which equals the
    // git-tracked l2/views/knowledge dir when l2OutputRoot=repo (the diagnostic
    // is runtime noise, never a projection; tracking it pollutes the L2 view).
    try {
      const diagPath = path.join(args.abrainHome, ".state", "sediment", "knowledge-projection", "overlay-budget.jsonl");
      await fs.mkdir(path.dirname(diagPath), { recursive: true });
      await fs.appendFile(diagPath, `${JSON.stringify({
        ts: new Date().toISOString(),
        event: "hot_overlay_budget_exceeded",
        candidates: candidates.length,
        selected: selected.length,
        selected_tokens: tokens,
        max_entries: budget.maxEntries,
        max_tokens: budget.maxTokens,
        deadline_ms: budget.deadlineMs,
        truncated,
        deadline_hit: deadlineHit,
      })}\n`, "utf-8");
    } catch { /* diagnostic is best-effort */ }
  }

  // Group selected files back per scope root, returning bounded stores.
  const byRoot = new Map<string, { scope: KnowledgeEvidenceScope; root: string; label: string; files: string[] }>();
  for (const c of selected) {
    let g = byRoot.get(c.root);
    if (!g) { g = { scope: c.scope, root: c.root, label: c.label, files: [] }; byRoot.set(c.root, g); }
    g.files.push(c.file);
  }
  return [...byRoot.values()];
}

/** ADR 0039 Phase C: the UNBOUNDED stable-view reader. Returns the full
 *  l2/views/knowledge (or .state) projection dirs as primary StoreRefs WITHOUT a
 *  `files` allow-list, so scanStore takes its normal full dir-walk path (same
 *  machinery as legacy stores). This is the post-flip canonical "stable view"
 *  role and MUST stay distinct from readKnowledgeProjectionStores (the bounded
 *  "recent hot overlay" role) — never apply the overlay's count/token/time caps
 *  here, or entries beyond the cap would silently vanish from the truth face.
 *  Gated only by `enabled` (NOT hotOverlayEnabled, which gates the overlay). */
export async function readKnowledgeStableViewStores(args: { abrainHome: string; projectId?: string; settings: SedimentSettings }): Promise<Array<{ scope: KnowledgeEvidenceScope; root: string; label: string }>> {
  if (!args.settings.knowledgeProjector.enabled) return [];
  const latest = path.join(stateRoot(args.abrainHome, args.settings), "latest");
  const stores: Array<{ scope: KnowledgeEvidenceScope; root: string; label: string }> = [];
  if (args.projectId) {
    const projectRoot = path.join(latest, "projects", args.projectId);
    const stat = await fs.stat(projectRoot).catch(() => null);
    if (stat?.isDirectory()) stores.push({ scope: "project", root: projectRoot, label: "knowledge-stable-project" });
  }
  const worldRoot = path.join(latest, "world");
  const worldStat = await fs.stat(worldRoot).catch(() => null);
  if (worldStat?.isDirectory()) stores.push({ scope: "world", root: worldRoot, label: "knowledge-stable-world" });
  return stores;
}
